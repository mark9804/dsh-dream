import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, realpath, lstat, copyFile } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishGeneration, atomicJson } from './publish-generation.js';
import { inputFingerprint, digest } from './build-inputs.js';
/** Development runtime entry is one atomically replaced module. Its imports and
 * Worker URLs point into an immutable retained generation, never a mixed tree. */
export async function publishDevelopment(project, manifest, { recheck = true } = {}) {
  project = await realpath(project);
  if (recheck) assert.equal((await inputFingerprint(project)).hash, manifest.inputHash, 'Source changed after validation; generation rejected in HMR queue');
  const runtime = join(project, '.dream-dev/runtime'), version = join(runtime, 'generations', manifest.revision);
  assert.match(manifest.revision, /^[a-f0-9-]{36}$/);
  const result = await publishGeneration(project, manifest, { targetRoot: version });
  const pkg = JSON.parse(await readFile(join(manifest.staged, 'package.json'), 'utf8'));
  const path = './generations/' + manifest.revision;
  const entry = `export * as settings from '${path}/dist/settings/entry.js';\nexport * as configuration from '${path}/dist/settings/owner.js';\nexport * as runtime from '${path}/dist/index.js';\nexport const buildRevision=${JSON.stringify(manifest.revision)};\n`;
  await mkdir(runtime, { recursive: true });
  const devPkg = { ...pkg, scripts: {}, files: ['generations/', 'generation.js', 'entry.js', 'configuration.js', 'runtime.js', 'web/', 'locale/', 'icon.svg', 'cordis.patch.yml'], exports: { ...pkg.exports, '.': './entry.js', './configuration': './configuration.js', './runtime': './runtime.js', './client': './web/client.js' } };
  // Stable three Loader entries all depend on the same generation switch.
  const wrappers = {
    'entry.js': "import {settings as p} from './generation.js';export const inject=p.inject;export function apply(...args){return p.apply(...args)}\n",
    'configuration.js': "import {configuration as p} from './generation.js';export const inject=p.inject;export const Config=p.Config;export function apply(...args){return p.apply(...args)}\n",
    'runtime.js': "import {runtime as p} from './generation.js';export const inject=p.inject;export const Config=p.Config;export function apply(...args){return p.apply(...args)}\n",
  };
  for (const [name, content] of Object.entries(wrappers)) {
    const target = join(runtime, name); let current; try { current = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== undefined) assert.equal(current, content, 'Development wrapper changed; reinstall the development runtime');
    else await writeFile(target, content, { flag: 'wx' });
  }
  await atomicJson(join(runtime, 'package.json'), devPkg);
  for (const name of ['cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json']) { await mkdir(dirname(join(runtime, name)), { recursive: true }); await copyFile(join(version, name), join(runtime, name)); }
  // The one Host marker changes only after the entire immutable generation exists.
  await atomicText(join(runtime, 'generation.js'), entry);
  await mkdir(join(runtime, 'web'), { recursive: true });
  await atomicText(join(runtime, 'web/client.js'), await readFile(join(version, 'web/client.js')));
  return { ...result, revision: manifest.revision, runtime, generation: version };
}
async function atomicText(path, content) {
  const temporary = path + '.' + randomUUID() + '.tmp'; await writeFile(temporary, content, { flag: 'wx' });
  const { rename } = await import('node:fs/promises');
  assert.equal(dirname(resolve(temporary)), dirname(resolve(path))); await rename(temporary, path);
}
