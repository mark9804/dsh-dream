import { watch } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, command } from './checked-build.js';
import { acquireBuildLock } from './lib/build-lock.js';
const root = fileURLToPath(new URL('..', import.meta.url)), state = join(root, '.dream-dev');
await mkdir(state, { recursive: true });
const releaseWatcher = await acquireBuildLock(root, 'watcher');
const stop = new AbortController(), watchers = [];
let dirty = true, running, timer, closed = false;
async function buildLatest() {
  if (running || closed) return;
  running = (async () => {
    while (dirty && !closed) {
      dirty = false;
      try { await command(root, ['scripts/checked-build.js'], { signal: stop.signal }); const result = JSON.parse(await readFile(join(state, 'published.json'), 'utf8')); await atomicJson(join(state, 'watcher-status.json'), { state: 'ready', pid: process.pid, revision: result.revision, at: new Date().toISOString() }); }
      catch (error) { if (closed) break; console.error('[dream:dev] Check/build/publication failed; inspect acknowledgement before assuming a live change:', error.message); await atomicJson(join(state, 'watcher-status.json'), { state: 'rejected', pid: process.pid, error: error.message, at: new Date().toISOString() }); }
    }
  })().finally(() => { running = undefined; });
  await running;
}
function schedule(_event, name) {
  if (closed || name && String(name).split(/[\\/]/).some(part => part.startsWith('.') || part.endsWith('.tmp'))) return;
  dirty = true; clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void buildLatest(); }, 300);
}
for (const directory of ['src', 'client', 'scripts', 'tests', 'locale', 'dev']) {
  const watcher = watch(join(root, directory), { recursive: directory !== 'tests' }, schedule); watcher.on('error', error => console.error('[dream:dev] Watch failure:', error)); watchers.push(watcher);
}
watchers.push(watch(join(root, 'tests/helpers'), { recursive: true }, schedule));
const rootInputs = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'AGENTS.md']);
watchers.push(watch(root, (_event, name) => { if (rootInputs.has(String(name))) schedule(_event, name); }));
async function close() {
  if (closed) return; closed = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); stop.abort(new Error('Dream developer watcher stopped'));
  await running; await releaseWatcher();
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void close().catch(console.error); });
console.log('[dream:dev] Watching project source/config/test inputs only; no server and no memory access');
await buildLatest();
