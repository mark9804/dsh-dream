import { watch } from 'node:fs';
import { readFile, mkdir, open, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, runCheckedBuild } from './checked-build.js';
const root = fileURLToPath(new URL('..', import.meta.url)), state = join(root, '.dream-dev');
await mkdir(state, { recursive: true });
const lockPath = join(state, 'watcher.lock.json');
try { const current = JSON.parse(await readFile(lockPath, 'utf8')); if (Number.isSafeInteger(current.pid) && current.pid > 0) { try { process.kill(current.pid, 0); throw new Error(`Dream watcher already running (${current.pid})`); } catch (error) { if (error.code !== 'ESRCH') throw error; } } } catch (error) { if (error.code !== 'ENOENT') throw error; }
await atomicJson(lockPath, { pid: process.pid, startedAt: new Date().toISOString() });
const stop = new AbortController(), watchers = [];
let dirty = true, running, timer, closed = false;
async function buildLatest() {
  if (running || closed) return;
  running = (async () => {
    while (dirty && !closed) {
      dirty = false;
      try { const result = await runCheckedBuild({ root, signal: stop.signal }); await atomicJson(join(state, 'watcher-status.json'), { state: 'ready', pid: process.pid, revision: result.revision, at: new Date().toISOString() }); }
      catch (error) { if (closed) break; console.error('[dream:dev] Check/build rejected; live code retained:', error.message); await atomicJson(join(state, 'watcher-status.json'), { state: 'rejected', pid: process.pid, error: error.message, at: new Date().toISOString() }); }
    }
  })().finally(() => { running = undefined; });
  await running;
}
function schedule(_event, name) {
  if (closed || name && String(name).split(/[\\/]/).some(part => part.startsWith('.') || part.endsWith('.tmp'))) return;
  dirty = true; clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void buildLatest(); }, 300);
}
for (const directory of ['src', 'client', 'scripts', 'tests', 'locale', 'dev']) {
  const watcher = watch(join(root, directory), { recursive: true }, schedule); watcher.on('error', error => console.error('[dream:dev] Watch failure:', error)); watchers.push(watcher);
}
const rootInputs = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.client.json', 'cordis.patch.yml', 'README.md', 'icon.svg', 'AGENTS.md']);
watchers.push(watch(root, (_event, name) => { if (rootInputs.has(String(name))) schedule(_event, name); }));
async function close() {
  if (closed) return; closed = true; clearTimeout(timer); for (const watcher of watchers) watcher.close(); stop.abort(new Error('Dream developer watcher stopped'));
  await running; await atomicJson(lockPath, { pid: 0, stoppedAt: new Date().toISOString() });
}
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void close().catch(console.error); });
console.log('[dream:dev] Watching project source/config/test inputs only; no server and no memory access');
await buildLatest();
