import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inputFingerprint, digest } from '../scripts/lib/build-inputs.js';
import { publishDevelopment } from '../scripts/lib/dev-publication.js';
import { acquireBuildLock } from '../scripts/lib/build-lock.js';
async function fixture() {
  const base = new URL('./.tmp/', import.meta.url); await mkdir(base, { recursive: true }); const project = await mkdtemp(new URL('dev-generation-', base).pathname), staged = join(project, 'tests/.tmp/stage/package');
  for (const dir of ['src', 'client', 'scripts', 'tests', 'locale', 'dev']) await mkdir(join(project, dir), { recursive: true }); await mkdir(staged, { recursive: true });
  const pkg = { name: 'dsh-dream', version: '0.1.7', type: 'module', exports: { './icon': './icon.svg' } };
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'AGENTS.md']) await writeFile(join(project, path), path === 'package.json' ? JSON.stringify(pkg) : 'synthetic');
  await writeFile(join(staged, 'package.json'), JSON.stringify(pkg)); const files = {};
  for (const path of ['dist/settings/entry.js', 'dist/settings/owner.js', 'dist/index.js', 'dist/dream/worker.js', 'dist/a.js', 'dist/b.js', 'dist/c.js', 'web/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) { const value = '/* ' + path + ' */'; await mkdir(join(staged, path, '..'), { recursive: true }); await writeFile(join(staged, path), value); files[path] = digest(value); }
  const manifest = { schemaVersion: 1, revision: randomUUID(), project, staged, files, inputHash: (await inputFingerprint(project)).hash, typecheck: 'passed', sourceIntegrity: 'passed', artifactIntegrity: 'passed', regressions: 'passed' };
  return { project, manifest };
}
test('queued stale source generation cannot switch live Host marker', async () => {
  const f = await fixture(); const first = await publishDevelopment(f.project, f.manifest);
  const previous = await readFile(join(first.runtime, 'generation.js'), 'utf8');
  await writeFile(join(f.project, 'src/changed.ts'), 'export const changed=true');
  const next = { ...f.manifest, revision: randomUUID() };
  await assert.rejects(publishDevelopment(f.project, next), /Source changed after validation/); assert.equal(await readFile(join(first.runtime, 'generation.js'), 'utf8'), previous);
});
test('immutable generations retain old Worker paths and one shared marker switches Host owners', async () => {
  const f = await fixture(), first = await publishDevelopment(f.project, f.manifest), old = await readFile(join(first.generation, 'dist/dream/worker.js'), 'utf8');
  const second = await publishDevelopment(f.project, { ...f.manifest, revision: randomUUID() });
  assert.notEqual(second.generation, first.generation); assert.equal(await readFile(join(first.generation, 'dist/dream/worker.js'), 'utf8'), old);
  const marker = await readFile(join(first.runtime, 'generation.js'), 'utf8'); assert.ok(marker.includes(second.revision)); assert.ok(!marker.includes(first.revision));
  for (const path of ['entry.js', 'configuration.js', 'runtime.js']) assert.match(await readFile(join(first.runtime, path), 'utf8'), /from '\.\/generation\.js'/);
});
test('atomic cross-process build lock excludes competing owner and releases only its own token', async () => {
  const f = await fixture(); const release = await acquireBuildLock(f.project);
  await assert.rejects(acquireBuildLock(f.project), /Another build owner is active/); await release(); await release();
  const next = await acquireBuildLock(f.project); await next();
});
test('stale lock never steals a second starters ownership', async () => {
  const f = await fixture(); await mkdir(join(f.project, '.dream-dev'));
  const path = join(f.project, '.dream-dev/build.lock.json'), value = JSON.stringify({ pid: 2147483647, token: randomUUID() }); await writeFile(path, value);
  await assert.rejects(acquireBuildLock(f.project), /Stale build lock requires explicit recovery/);
  assert.equal(await readFile(path, 'utf8'), value);
});
