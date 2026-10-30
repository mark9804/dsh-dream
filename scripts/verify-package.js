import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// This is an explicit release check, not an npm test hook. It never publishes.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = join(root, 'tests/.tmp');
await mkdir(temporary, { recursive: true });
const directory = await mkdtemp(join(temporary, 'package-'));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]))[0];
const paths = packed.files.map(file => file.path);
const sources = (await readdir(join(root, 'src'), { recursive: true })).filter(path => path.endsWith('.ts') && !path.endsWith('.d.ts'));
const expectedEmit = sources.flatMap(path => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(extension => 'dist/' + path.slice(0, -3) + extension));
assert.deepEqual(paths.filter(path => path.startsWith('dist/')).sort(), expectedEmit.sort(), 'Missing or stale build output: inspect dist rather than publishing it');
for (const path of paths) {
  assert.ok(path === 'package.json' || path === 'README.md' || path === 'icon.svg' || path === 'cordis.patch.yml' ||
    /^locale\/[a-zA-Z-]+\.json$/.test(path) || /^dist\/[a-zA-Z0-9_/-]+\.(?:js|d\.ts)(?:\.map)?$/.test(path), `Unexpected published file: ${path}`);
}
for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/dream/worker.js', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml']) assert.ok(paths.includes(required), required);
const archive = join(directory, packed.filename);
run('tar', ['-xzf', archive, '-C', directory]);
const extracted = join(directory, 'package');
const pkg = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
const entry = await import(pathToFileURL(join(extracted, pkg.exports['.'].import)).href);
assert.equal(typeof entry.apply, 'function');
assert.throws(() => entry.apply({}, {}), /sessionId is required/);
assert.equal((await readdir(extracted)).includes('src'), false);
// Exercise the complete existing synthetic worker/transaction/compaction/reload
// demonstration against extracted JS, not workspace src or dist modules.
let demo = await readFile(join(root, 'scripts/demo.js'), 'utf8');
demo = demo.replaceAll("'../dist/", `'${pathToFileURL(join(extracted, 'dist')).href}/`);
demo = demo.replace("new URL('../tests/.tmp/', import.meta.url)", `new URL(${JSON.stringify(pathToFileURL(temporary + '/').href)})`);
const demoPath = join(directory, 'packed-demo.mjs');
await writeFile(demoPath, demo, { flag: 'wx' });
const result = spawnSync(process.execPath, [demoPath], { cwd: extracted, encoding: 'utf8' });
if (result.error) throw result.error;
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
const packedPipelineTests = (await readFile(join(root, 'tests/pipeline.test.js'), 'utf8')).replaceAll("'../dist/", `'${pathToFileURL(join(extracted, 'dist')).href}/`);
const pipelineTestPath = join(directory, 'packed-pipeline.test.mjs');
await writeFile(pipelineTestPath, packedPipelineTests, { flag: 'wx' });
console.log(run(process.execPath, ['--test', pipelineTestPath], extracted));
const cleanReviewTests = (await readFile(join(root, 'tests/clean-review.test.js'), 'utf8')).replaceAll("'../dist/", `'${pathToFileURL(join(extracted, 'dist')).href}/`);
const reviewTestPath = join(directory, 'packed-clean-review.test.mjs');
await writeFile(reviewTestPath, cleanReviewTests, { flag: 'wx' });
console.log(run(process.execPath, ['--test', reviewTestPath], extracted));
console.log(JSON.stringify({ archive, extracted, files: paths.length, integrity: packed.integrity, shasum: packed.shasum, artifactEntry: 'passed', syntheticFullFlow: 'passed', packedWorkerRegression: 'passed', packedCleanReviewRegression: 'passed', published: false }, null, 2));
console.log(result.stdout);
