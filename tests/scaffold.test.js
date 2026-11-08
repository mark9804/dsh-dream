import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { apply } from '../dist/index.js';

const root = new URL('../', import.meta.url);
const text = (path) => readFile(new URL(path, root), 'utf8');

test('Host entry rejects missing configuration before accessing services', () => {
  const forbidden = new Proxy({}, {
    get() { throw new Error('Scaffold must not access Host services'); },
    set() { throw new Error('Scaffold must not mutate Host context'); },
  });
  assert.throws(() => apply(forbidden, Object.freeze({})), /sessionId is required/);
});

test('manifest exports compiled ESM and declarations with narrow publish resources', async () => {
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports['.'], { types: './dist/settings/entry.d.ts', import: './dist/settings/entry.js' });
  assert.deepEqual(pkg.exports['./runtime'], { types: './dist/index.d.ts', import: './dist/index.js' });
  assert.deepEqual(pkg.exports['./configuration'], { types: './dist/settings/owner.d.ts', import: './dist/settings/owner.js' });
  assert.equal(pkg.exports['./client'], './web/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const path of [pkg.exports['.'].import, pkg.exports['.'].types, pkg.exports['./icon'], pkg.dsh.bundle.patch]) {
    assert.ok((await stat(new URL(path, root))).isFile());
    const relative = path.startsWith('./') ? path.slice(2) : path;
    assert.ok(pkg.files.some((item) => item === relative ||
      (item.endsWith('/') && relative.startsWith(item))));
  }
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.deepEqual(pkg.files, ['dist/', 'web/client.js', 'web/client.js.map', 'client/NOTICE.md', 'client/SHADCN_LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'locale/*.json', 'icon.svg', 'cordis.patch.yml', 'README.md']);
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.engines.node, '>=24.9');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
});

test('bundle row uses the package name and remains disabled by default', async () => {
  const pkg = JSON.parse(await text('package.json'));
  const patch = await text(pkg.dsh.bundle.patch);
  assert.match(patch, /^- insert:/m);
  assert.ok(patch.split('\n').some(line => line.trim() === '- id: dsh-dream'));
  assert.ok(patch.split('\n').some(line => line.trim() === `name: ${pkg.name}`));
  assert.ok(patch.includes('disabled: true'));
});

test('English and Chinese metadata describe the plugin', async () => {
  for (const locale of ['en', 'zh']) {
    const { meta } = JSON.parse(await text(`locale/${locale}.json`));
    assert.ok(meta.title.trim());
    assert.ok(meta.description.trim());
  }
});
