import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, realpath, rename, readdir } from 'node:fs/promises';
import { resolve, relative, join, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
function inside(base, value) { const result = resolve(base, value), part = relative(base, result); assert.ok(part && part !== '..' && !part.startsWith('../') && !isAbsolute(part), 'Publication path escapes its validated root'); return result; }
async function safePath(base, path) {
  const target = inside(base, path), part = relative(base, target); let current = base;
  for (const name of part.split('/')) {
    current = join(current, name);
    try { assert.ok(!(await lstat(current)).isSymbolicLink(), 'Publication paths must not traverse symlinks'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  assert.equal(dirname(resolve(temporary)), dirname(resolve(path))); await rename(temporary, path);
}
const allowed = path => /^dist\/[a-zA-Z0-9_/-]+\.(?:js|d\.ts)(?:\.map)?$/.test(path)
  || ['web/client.js', 'THIRD_PARTY_NOTICES.txt', 'README.md', 'cordis.patch.yml', 'icon.svg', 'client/NOTICE.md', 'client/SHADCN_LICENSE.txt', 'locale/en.json', 'locale/zh.json'].includes(path);
/** Validate every byte before mutation, then publish inside the caller's HMR queue.
 * Readers see atomic individual files; the queue prevents Host loading a partial generation.
 * Client entry is written last so bundle polling never sees half-written JavaScript. */
export async function publishGeneration(project, manifest, { targetRoot = project } = {}) {
  project = await realpath(project); assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.project, project);
  assert.equal(manifest.typecheck, 'passed'); assert.equal(manifest.sourceIntegrity, 'passed'); assert.equal(manifest.artifactIntegrity, 'passed');
  assert.ok(['passed', 'not-requested'].includes(manifest.regressions));
  const staged = await realpath(manifest.staged); inside(join(project, 'tests/.tmp'), staged);
  const entries = Object.entries(manifest.files); assert.ok(entries.length > 10 && entries.length < 1000);
  const buffers = new Map();
  for (const [path, expected] of entries) {
    assert.ok(allowed(path), 'Unexpected publication artifact'); assert.match(expected, /^[a-f0-9]{64}$/);
    const bytes = await readFile(await safePath(staged, path)); assert.equal(sha(bytes), expected, `Validated artifact changed: ${path}`); buffers.set(path, bytes);
  }
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')); assert.equal(pkg.name, 'dsh-dream');
  targetRoot = resolve(targetRoot); await mkdir(targetRoot, { recursive: true }); targetRoot = await realpath(targetRoot);
  if (targetRoot !== project) inside(project, targetRoot);
  const changed = [];
  for (const [path, bytes] of [...buffers].sort(([a], [b]) => (a === 'web/client.js' ? 1 : b === 'web/client.js' ? -1 : a.localeCompare(b)))) {
    const target = await safePath(targetRoot, path); let old;
    try { old = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (old && sha(old) === sha(bytes)) continue;
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, bytes, { flag: 'wx' });
    // Recheck both exact sibling targets before the atomic replacement.
    await safePath(targetRoot, relative(targetRoot, temporary)); await safePath(targetRoot, path);
    assert.equal(dirname(resolve(temporary)), dirname(resolve(target))); await rename(temporary, target); changed.push(path);
  }
  return { state: 'completed', changed, completedAt: new Date().toISOString(), artifactHash: sha(JSON.stringify(manifest.files)) };
}
