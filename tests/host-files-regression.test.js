import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createHostFiles } from '../dist/harness/files.js';

// Entirely in-memory Host seam: no profile or real memory I/O.
function fixture() {
  const root = `/synthetic/${randomUUID()}`;
  const roots = { memoryRoot: `${root}/memory`, stateRoot: `${root}/state` };
  const records = new Map();
  let version = 0;
  const controls = { mode: 'allowed', releaseFailure: false, writes: [], textReads: 0, byteReads: [] };
  const fs = {
    async resolve(path) { return { targetKey: path, displayPath: path }; },
    contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`); },
    async stat(target) {
      const record = records.get(target.targetKey);
      if (record) return { type: 'file', version: record.version, size: Buffer.byteLength(record.content) };
      if ([...records.keys()].some(path => path.startsWith(`${target.targetKey}/`))) return { type: 'directory', version: 'directory' };
    },
    async readText(target, signal) { signal?.throwIfAborted(); controls.textReads++; return records.get(target.targetKey).content; },
    async readBytes(target, signal, maxBytes) {
      signal?.throwIfAborted(); controls.byteReads.push({ signal, maxBytes });
      const bytes = Buffer.from(records.get(target.targetKey).content);
      if (bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'FS_TOO_LARGE' });
      return bytes;
    },
    async listDir(target) {
      return [...records.keys()].filter(path => dirname(path) === target.targetKey).map(path => ({ name: path.slice(target.targetKey.length + 1), type: 'file' }));
    },
    async writeText(target, content, expected, signal, policy) {
      signal?.throwIfAborted();
      controls.writes.push({ path: target.targetKey, policy });
      if (policy.mode === 'denied' || (controls.releaseFailure && target.targetKey.endsWith('.released.json'))) throw Object.assign(new Error('write denied'), { code: 'EACCES' });
      const old = records.get(target.targetKey);
      if (expected.kind === 'createIfAbsent' && old) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      if (expected.kind === 'replaceIfVersion' && old?.version !== expected.version) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      const next = String(++version); records.set(target.targetKey, { content, version: next });
      return { version: next };
    },
  };
  const ctx = { fs, sandboxPolicy: { resolve: ({ session }) => ({ mode: controls.mode, sessionId: session.id }) } };
  const create = (id = 'current', signal) => createHostFiles(ctx, { session: { id } }, { roots, signal });
  const seed = (path, content) => records.set(path, { content, version: String(++version) });
  return { roots, fs, records, controls, create, seed };
}

for (const kind of ['state', 'generation']) {
  test(`${kind} release failure recovers with a live PID using only the new caller policy`, async () => {
    const f = fixture();
    const run = (files, task) => kind === 'state' ? files.withLock('key', task) : files.withGenerationLock(task);
    f.controls.releaseFailure = true;
    await assert.rejects(run(f.create('original'), async () => 'finished'), /write denied/);
    assert.equal(f.records.size, 1);
    f.controls.releaseFailure = false;
    f.controls.mode = 'denied';
    await assert.rejects(run(f.create('restricted'), () => assert.fail('must not run after denied recovery')), /write denied/);
    assert.equal(f.controls.writes.at(-1).policy.sessionId, 'restricted');
    assert.equal(f.controls.writes.at(-1).policy.mode, 'denied');
    f.controls.mode = 'allowed';
    assert.equal(await run(f.create('fresh'), async () => 'recovered'), 'recovered');
    assert.equal(f.records.size, 4);
    assert.equal(f.controls.writes.at(-1).policy.sessionId, 'fresh');
  });
}

test('operation and release errors are both retained and the lock remains recoverable', async () => {
  const f = fixture(); f.controls.releaseFailure = true;
  await assert.rejects(f.create().withLock('key', () => { throw new Error('operation failed'); }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /operation failed/);
    assert.match(error.errors[1].message, /write denied/);
    return true;
  });
  f.controls.releaseFailure = false;
  await f.create().withLock('key', async () => {});
});

test('an unrecognized live owner is never recovered', async () => {
  const f = fixture();
  f.seed(join(f.roots.memoryRoot, '.dsh-dream-locks/000000000001.acquire.json'), JSON.stringify({ pid: process.pid, ownerToken: 'not-our-finished-operation' }));
  await assert.rejects(f.create().withLock('key', () => assert.fail('must stay locked')), { code: 'LOCKED' });
  assert.equal(f.controls.writes.length, 0);
});

test('concurrent callers retain single flight while failed release is recovered', async () => {
  const f = fixture(); let exit; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { exit = resolve; });
  f.controls.releaseFailure = true;
  const first = f.create().withLock('key', async () => { entered(); await waiting; });
  await started;
  let secondRan = false;
  const firstRejected = assert.rejects(first, /write denied/).then(() => { f.controls.releaseFailure = false; });
  const second = f.create().withLock('key', async () => { secondRan = true; });
  assert.equal(secondRan, false);
  exit(); await firstRejected; await second;
  assert.equal(secondRan, true);
});

test('bounded reads preflight size and use the verified readBytes seam, never readText', async () => {
  const f = fixture(); const path = join(f.roots.memoryRoot, 'source.md');
  f.seed(path, '鲸');
  const files = f.create();
  await assert.rejects(files.read(path, { maxBytes: 2 }), { code: 'FS_TOO_LARGE' });
  assert.equal(f.controls.byteReads.length, 0);
  const signal = new AbortController().signal;
  assert.equal((await files.read(path, { maxBytes: 3, signal })).content, '鲸');
  assert.deepEqual(f.controls.byteReads, [{ signal, maxBytes: 3 }]);
  assert.equal(f.controls.textReads, 0);
  assert.equal((await files.read(path, signal)).content, '鲸');
  assert.equal(f.controls.textReads, 1);
});

test('growth after stat is bounded by the backend and missing bounded support fails closed', async () => {
  const f = fixture(); const path = join(f.roots.memoryRoot, 'source.md'); f.seed(path, 'small');
  const originalStat = f.fs.stat;
  f.fs.stat = async target => { const info = await originalStat(target); f.seed(path, 'grown content beyond cap'); return info; };
  await assert.rejects(f.create().read(path, { maxBytes: 5 }), { code: 'FS_TOO_LARGE' });
  assert.equal(f.controls.textReads, 0);
  f.fs.stat = originalStat; delete f.fs.readBytes;
  await assert.rejects(f.create().read(path, { maxBytes: 100 }), { code: 'UNAVAILABLE' });
});

test('bounded reads retain stale-version and UTF-8 text validation', async () => {
  const f = fixture(); const path = join(f.roots.memoryRoot, 'source.md'); f.seed(path, 'text');
  f.fs.readBytes = async () => { f.seed(path, 'edit'); return Buffer.from('text'); };
  await assert.rejects(f.create().read(path, { maxBytes: 4 }), { code: 'FS_STALE_VERSION' });
  for (const bytes of [Uint8Array.of(0xff), Uint8Array.of(0)]) {
    f.fs.readBytes = async () => bytes;
    await assert.rejects(f.create().read(path, { maxBytes: 4 }), { code: 'FS_NOT_TEXT' });
  }
});
