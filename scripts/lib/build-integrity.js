import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import ts from 'typescript';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function confined(root, path) {
  const result = resolve(root, path), part = relative(resolve(root), result);
  assert.ok(part !== '..' && !part.startsWith('../') && !isAbsolute(part), `Path escapes build root: ${path}`);
  return result;
}
export async function filesBelow(root, directory, { hidden = false } = {}) {
  const files = [];
  async function visit(part) {
    for (const entry of await readdir(confined(root, part), { withFileTypes: true })) {
      if (!hidden && entry.name.startsWith('.')) continue;
      const path = join(part, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Build input/output must not be a symlink: ${path}`);
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
  for (const path of paths) rows.push([path, digest(await readFile(confined(root, path)))]);
  return { hash: digest(JSON.stringify(rows)), rows };
}
export async function checkSourceIntegrity(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')), lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-dream'); assert.equal(pkg.type, 'module');
  assert.equal(lock.name, pkg.name); assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies, 'Lockfile dev dependencies differ from manifest');
  assert.equal(pkg.exports['.'].import, './dist/settings/entry.js'); assert.equal(pkg.exports['./runtime'].import, './dist/index.js'); assert.equal(pkg.exports['./configuration'].import, './dist/settings/owner.js');
  assert.equal(pkg.exports['./client'], './web/client.js'); assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const locale of ['en', 'zh']) {
    const data = JSON.parse(await readFile(join(root, 'locale', locale + '.json'), 'utf8'));
    assert.ok(data.meta?.title?.trim() && data.meta?.description?.trim(), `Incomplete display metadata: ${locale}`);
  }
  const icon = await readFile(join(root, 'icon.svg'), 'utf8'); assert.ok(icon.includes('<svg') && icon.includes('</svg>') && Buffer.byteLength(icon) <= 262144);
  const paths = [...await filesBelow(root, 'src'), ...await filesBelow(root, 'client')];
  for (const path of paths.filter(p => /\.(?:ts|tsx)$/.test(p))) {
    const source = ts.createSourceFile(path, await readFile(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = [];
    function visit(node) { if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text); ts.forEachChild(node, visit); }
    visit(source);
    for (const spec of imports.filter(p => p.startsWith('.'))) {
      const resolved = confined(root, join(dirname(path), spec));
      const candidates = spec.endsWith('.js') ? [resolved.slice(0, -3) + '.ts', resolved.slice(0, -3) + '.tsx', resolved] : [resolved];
      let found = false; for (const candidate of candidates) try { const info = await lstat(candidate); assert.ok(!info.isSymbolicLink()); if (info.isFile()) { found = true; break; } } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(found, `Missing local import ${path}: ${spec}`);
    }
  }
  return { sources: paths.filter(p => p.endsWith('.ts')).length, packageVersion: pkg.version };
}
export async function checkArtifactIntegrity(root) {
  const sources = (await filesBelow(root, 'src')).filter(p => p.endsWith('.ts') && !p.endsWith('.d.ts'));
  const expected = sources.flatMap(p => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(ext => 'dist/' + p.slice(4, -3) + ext)).sort();
  assert.deepEqual(await filesBelow(root, 'dist'), expected, 'Compiled output incomplete or stale');
  const client = await readFile(join(root, 'web/client.js'), 'utf8');
  assert.ok(client.startsWith('window.__ModuleLoader__.load({id:"dsh-dream"')); new Script(client, { filename: 'web/client.js' });
  const notice = await readFile(join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8'); assert.ok(notice.includes('Copyright (c) 2023 shadcn'));
  const paths = [...expected, 'web/client.js', 'THIRD_PARTY_NOTICES.txt', 'icon.svg', 'README.md', 'cordis.patch.yml', 'client/NOTICE.md', 'client/SHADCN_LICENSE.txt', 'locale/en.json', 'locale/zh.json'];
  const files = {}; for (const path of paths) { const actual = await realpath(confined(root, path)); confined(root, relative(root, actual)); files[path] = digest(await readFile(actual)); }
  return files;
}
