import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkArtifactIntegrity, checkSourceIntegrity, inputFiles, inputFingerprint, confined } from './lib/build-integrity.js';
const project = fileURLToPath(new URL('..', import.meta.url));
export async function command(root, args, { signal, env = process.env } = {}) {
  signal?.throwIfAborted();
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { signal?.removeEventListener('abort', abort); fail(error); });
    child.once('exit', (code, stopped) => { signal?.removeEventListener('abort', abort); if (signal?.aborted) fail(signal.reason); else if (code === 0) done(); else fail(new Error(`Build command failed (${code ?? stopped}): ${args.join(' ')}`)); });
  });
}
export { atomicJson } from './lib/publish-generation.js';
import { atomicJson } from './lib/publish-generation.js';
export async function createStage(root = project) {
  root = await realpath(root); const temporary = join(root, 'tests/.tmp'); await mkdir(temporary, { recursive: true });
  const generation = await mkdtemp(join(temporary, 'checked-build-')), staged = join(generation, 'package'); await mkdir(staged);
  const before = await inputFingerprint(root), paths = await inputFiles(root);
  for (const path of paths) { const to = confined(staged, path); await mkdir(dirname(to), { recursive: true }); await copyFile(confined(root, path), to); }
  await symlink(join(root, 'node_modules'), join(staged, 'node_modules'), 'dir');
  assert.equal((await inputFingerprint(root)).hash, before.hash, 'Source changed while snapshotting; retry with latest inputs');
  return { root, staged, generation, inputHash: before.hash };
}
export async function runCheckedBuild(options = {}) {
  const { acquireBuildLock } = await import('./lib/build-lock.js');
  const release = await acquireBuildLock(options.root ?? project);
  try { return await checkedBuild(options); } finally { await release(); }
}
async function checkedBuild({ root = project, publish = true, tests = true, signal, afterChecks, development = false } = {}) {
  if (process.env.DSH_DREAM_STAGED_TEST === '1') throw new Error('A staged regression cannot recursively start another checked build');
  const stage = await createStage(root); signal?.throwIfAborted();
  const { staged, generation } = stage;
  console.log('[dream:build] Checking both TypeScript projects and source integrity before emit');
  await command(staged, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'], { signal });
  await command(staged, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.client.json', '--noEmit'], { signal });
  await command(staged, ['scripts/check.js'], { signal }); await checkSourceIntegrity(staged);
  await afterChecks?.(stage); signal?.throwIfAborted();
  console.log('[dream:build] Emitting into an isolated generation, never the live package');
  await command(staged, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { signal });
  await command(staged, ['scripts/build-client.js'], { signal });
  const files = await checkArtifactIntegrity(staged);
  if (tests) {
    console.log('[dream:build] Running full offline regression suite against this generation');
    const paths = (await inputFiles(staged)).filter(path => /^tests\/[^/]+\.test\.js$/.test(path));
    await command(staged, ['--test', ...paths], { signal, env: { ...process.env, DSH_DREAM_STAGED_TEST: '1' } });
  }
  signal?.throwIfAborted();
  assert.equal((await inputFingerprint(stage.root)).hash, stage.inputHash, 'Source changed during checks/build; validated generation not published');
  const revision = randomUUID(), manifest = { schemaVersion: 1, revision, project: stage.root, staged, inputHash: stage.inputHash, files, checkedAt: new Date().toISOString(), typecheck: 'passed', sourceIntegrity: 'passed', artifactIntegrity: 'passed', regressions: tests ? 'passed' : 'not-requested' };
  await atomicJson(join(generation, 'manifest.json'), manifest);
  if (publish) {
    const { publishGeneration } = await import('./lib/publish-generation.js');
    const attached = join(stage.root, '.dream-dev/attached.json'); let active = false;
    try { const data = JSON.parse(await readFile(attached, 'utf8')); if (Number.isSafeInteger(data.pid) && data.pid > 0 && data.active === true && data.project === stage.root) { process.kill(data.pid, 0); active = true; } } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code) && !(error instanceof SyntaxError)) throw error; }
    if (active) {
      assert.ok(tests, 'Linked development publication requires the complete regression gate; use npm run build:checked');
      // The editable project is not the installed runtime. Keep release artifacts
      // current as well, without exposing them to running Host/Worker instances.
      await publishGeneration(stage.root, manifest);
      console.log('[dream:build] Handing a validated generation to the active Harness HMR queue');
      await atomicJson(join(stage.root, '.dream-dev/pending.json'), { manifest: join(generation, 'manifest.json'), revision });
      await awaitReceipt(stage.root, revision, signal);
    } else {
      // Initial/offline build. A linked running profile must have the dev bridge active.
      try {
        const link = process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules/dsh-dream');
        if (link && [stage.root, join(stage.root, '.dream-dev/runtime')].includes(await realpath(link))) throw new Error('Dream is linked into this profile but its development bridge is not active; refusing uncoordinated publication');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await readFile(join(stage.root, '.dream-dev/linked.json')); throw new Error('Linked development mode requires its bridge; refusing offline publication'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (development) {
        const { publishDevelopment } = await import('./lib/dev-publication.js');
        const result = await publishDevelopment(stage.root, manifest);
        await atomicJson(join(stage.root, '.dream-dev/published.json'), { revision, ...result, offline: true });
      } else {
        const result = await publishGeneration(stage.root, manifest);
        await atomicJson(join(stage.root, '.dream-dev/published.json'), { revision, ...result, offline: true });
      }
    }
  }
  console.log(`[dream:build] ${publish ? 'Published' : 'Validated'} generation ${revision}`);
  return { ...stage, revision, manifest };
}
async function awaitReceipt(root, revision, signal) {
  const { setTimeout: delay } = await import('node:timers/promises');
  for (let elapsed = 0; elapsed < 180000; elapsed += 250) {
    signal?.throwIfAborted();
    try { const value = JSON.parse(await readFile(join(root, '.dream-dev/published.json'), 'utf8')); if (value.revision === revision) { assert.equal(value.state, 'completed', value.error ?? 'HMR publication failed'); return; } } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await delay(250, undefined, { signal });
  }
  throw new Error('Harness did not acknowledge the validated generation; live update is unconfirmed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController(); for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => stop.abort(new Error('Checked build stopped')));
  try { await runCheckedBuild({ tests: !process.argv.includes('--skip-tests'), publish: !process.argv.includes('--no-publish'), signal: stop.signal, development: process.argv.includes('--prepare-development') }); }
  catch (error) { console.error('[dream:build] Not published:', error.message); process.exitCode = 1; }
}
