import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkSourceIntegrity, checkArtifactIntegrity, inputFingerprint } from '../scripts/lib/build-integrity.js';
import { publishGeneration } from '../scripts/lib/publish-generation.js';
const root = new URL('../', import.meta.url).pathname;
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const temp = new URL('./.tmp/', import.meta.url); await mkdir(temp, { recursive: true }); const project = await mkdtemp(new URL('checked-publish-', temp).pathname);
  const staged = join(project, 'tests/.tmp/generation/package'); await mkdir(staged, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'dsh-dream' }));
  const files = {};
  for (let i = 0; i < 10; i++) { const p = `dist/file-${i}.js`, content = `export const value = ${i};\n`; await mkdir(join(staged, 'dist'), { recursive: true }); await writeFile(join(staged, p), content); files[p] = sha(content); }
  await mkdir(join(staged, 'web'), { recursive: true }); const text = '/* synthetic single client artifact */'; await writeFile(join(staged, 'web/client.js'), text); files['web/client.js'] = sha(text);
  return { project, staged, manifest: { schemaVersion: 1, project, staged, files, typecheck: 'passed', sourceIntegrity: 'passed', artifactIntegrity: 'passed', regressions: 'passed' } };
}
test('source integrity verifies lock, display resources and local imports without emitting', async () => {
  const result = await checkSourceIntegrity(root); assert.ok(result.sources > 0); assert.ok(result.packageVersion);
  const before = await inputFingerprint(root); const after = await inputFingerprint(root); assert.equal(after.hash, before.hash);
});
test('validated generation publishes only allowlisted complete bytes, with client last and unchanged bytes untouched', async () => {
  const f = await fixture(); const first = await publishGeneration(f.project, f.manifest); assert.equal(first.state, 'completed'); assert.equal(first.changed.at(-1), 'web/client.js');
  assert.equal(await readFile(join(f.project, 'dist/file-3.js'), 'utf8'), 'export const value = 3;\n');
  assert.deepEqual((await publishGeneration(f.project, f.manifest)).changed, []);
});
test('tampered or unsafe generation is rejected before changing any live file', async () => {
  for (const type of ['tampered', 'path', 'unchecked']) {
    const f = await fixture(); await mkdir(join(f.project, 'dist')); await writeFile(join(f.project, 'dist/file-0.js'), 'previous live');
    if (type === 'tampered') await writeFile(join(f.staged, 'dist/file-9.js'), 'modified after check');
    if (type === 'path') f.manifest.files['../outside.js'] = '0'.repeat(64);
    if (type === 'unchecked') f.manifest.typecheck = 'failed';
    await assert.rejects(publishGeneration(f.project, f.manifest)); assert.equal(await readFile(join(f.project, 'dist/file-0.js'), 'utf8'), 'previous live');
  }
});
test('dev bridge uses one exact completion marker inside Harness queue, not global roots or model tools', async () => {
  const source = await readFile(new URL('../dev/bridge.js', import.meta.url), 'utf8');
  assert.match(source, /ctx\.hmr\.watchConfig\(filename, process\)/); assert.match(source, /publishDevelopment\(project, manifest\)/); assert.match(source, /ctx\.hmr\.reconcileProfile/);
  assert.doesNotMatch(source, /runExclusive\(|tools\.register|fetch\.register|root:\s*\[/);
  const builder = await readFile(new URL('../scripts/checked-build.js', import.meta.url), 'utf8');
  assert.ok(builder.indexOf("'--noEmit'") < builder.indexOf("['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']"));
  assert.match(builder, /Source changed during checks\/build; validated generation not published/);
  const watcher = await readFile(new URL('../scripts/dev.js', import.meta.url), 'utf8'); assert.match(watcher, /while \(dirty && !closed\)/); assert.doesNotMatch(watcher, /createServer|listen\(/);
});
