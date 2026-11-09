import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function confined(root, path) {
  const result = resolve(root, path), part = relative(resolve(root), result);
  assert.ok(part !== '..' && !part.startsWith('../') && !isAbsolute(part), `Path escapes build root: ${path}`); return result;
}
export async function filesBelow(root, directory, { hidden = false } = {}) {
  const files = [];
  async function visit(part) {
    assert.ok(!(await lstat(confined(root, part))).isSymbolicLink(), 'Build directory must not be a symlink');
    confined(await realpath(root), relative(await realpath(root), await realpath(confined(root, part))));
    for (const entry of await readdir(confined(root, part), { withFileTypes: true })) {
      if (!hidden && entry.name.startsWith('.')) continue;
      const path = join(part, entry.name); assert.ok(!entry.isSymbolicLink(), `Build input/output must not be a symlink: ${path}`);
      if (entry.isDirectory()) await visit(path); else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory); return files.sort();
}
export async function inputFiles(root) {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'AGENTS.md'];
  for (const directory of ['src', 'client', 'scripts', 'tests', 'locale', 'dev']) {
    try { paths.push(...await filesBelow(root, directory)); } catch (error) { if (error.code !== 'ENOENT' || directory !== 'dev') throw error; }
  }
  return [...new Set(paths)].sort();
}
export async function inputFingerprint(root) {
  const paths = await inputFiles(root), rows = [];
  for (const path of paths) {
    assert.ok(!(await lstat(confined(root, path))).isSymbolicLink(), 'Build input must not be a symlink');
    rows.push([path, digest(await readFile(confined(root, path)))]);
  }
  return { hash: digest(JSON.stringify(rows)), rows };
}
