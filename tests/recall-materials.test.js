import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { collectRecallSnapshot } from '../dist/dream/recall-materials.js';
import { collectSnapshot, protectedText } from '../dist/dream/materials.js';
import { validateSnapshot } from '../dist/domain/contracts.js';

// Entirely synthetic in-memory Files boundary. No Host, real memory, model or disk.
const scope = { scopeId: 'synthetic-scope', agentId: 'synthetic-agent', sessionId: 'synthetic-session', memoryRootId: 'synthetic-root' };
const now = new Date('2026-11-04T12:00:00.000Z');
const config = { memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state', timeZone: 'UTC',
  maxSourceBytes: 131072, maxInputBytes: 524288, recallHistoryDays: 90, maxRecallFiles: 128, maxRecallBytes: 1048576 };
const options = { now, snapshotId: 'synthetic-recall-snapshot' };
const entry = name => ({ name, isDirectory: false });
const pathOf = path => join(config.memoryRoot, path);
const error = code => Object.assign(new Error(`Synthetic ${code}`), { code });

function fixture(daily = {}, extra = {}) {
  const filesByPath = new Map([
    [pathOf('long-term.md'), { content: 'Synthetic stable memory.', version: { revision: 1 } }],
    [pathOf('decisions.md'), { content: 'Synthetic decision.', version: { revision: 1 } }],
    [pathOf('journal.md'), { content: 'Synthetic journal.', version: { revision: 1 } }],
    ...Object.entries(daily).map(([name, content]) => [pathOf(`daily/${name}`), { content, version: { revision: 1 } }]),
    ...Object.entries(extra).map(([path, content]) => [pathOf(path), { content, version: { revision: 1 } }]),
  ]);
  const listings = new Map([
    [pathOf('daily'), Object.keys(daily).map(entry)],
    [pathOf('ideas'), Object.keys(extra).filter(path => path.startsWith('ideas/')).map(path => entry(path.slice(6)))],
  ]);
  const reads = [], stats = [], lists = [];
  const files = {
    async list(path) { lists.push(path); assert.ok(listings.has(path), `unexpected listing ${path}`); return structuredClone(listings.get(path)); },
    async stat(path) {
      stats.push(path);
      if (listings.has(path)) return { type: 'directory' };
      const item = filesByPath.get(path);
      return item ? { type: 'file', size: Buffer.byteLength(item.content), version: structuredClone(item.version) } : null;
    },
    async read(path, opts) {
      reads.push({ path, maxBytes: opts?.maxBytes });
      const item = filesByPath.get(path);
      if (!item) return null;
      assert.ok(Number.isSafeInteger(opts?.maxBytes));
      if (Buffer.byteLength(item.content) > opts.maxBytes) throw error('FS_TOO_LARGE');
      return structuredClone(item);
    },
    async write() { assert.fail('collection must not write'); }, async mkdir() { assert.fail('collection must not mkdir'); },
    async withLock() { assert.fail('collection must not take mutation locks'); },
  };
  return { files, filesByPath, listings, reads, stats, lists };
}
const collect = (f, overrides = {}, opts = options) => collectRecallSnapshot(f.files, { ...config, ...overrides }, scope, opts);
const historical = result => result.snapshot.sources.filter(source => source.role === 'daily');
const omission = (result, id) => result.coverage.omissions.find(item => item.sourceId === id)?.reason;

test('query collection preserves the base snapshot and rereads historical daily bytes only', async () => {
  const entries = { '2026-11-04.md': 'Today.', '26-11-03.md': 'Yesterday.', '2026-11-02.md': 'Two days ago.',
    '2026-11-01.md': 'Synthetic historical mint tea.', '2026-10-10.md': 'Synthetic older event.' };
  const f = fixture(entries, { 'ideas/open.md': 'Synthetic idea.', 'archive/old.md': 'Never read archive.', 'dreams/dream.md': 'Never read dream.', 'state/job.json': 'Never read state.' });
  const base = await collectSnapshot(f.files, config, scope, options);
  f.reads.length = 0; f.stats.length = 0; f.lists.length = 0;
  const result = await collect(f);
  assert.equal(validateSnapshot(result.snapshot), result.snapshot);
  assert.deepEqual(result.snapshot.sources.slice(0, base.sources.length), base.sources);
  assert.deepEqual(result.currentSnapshot, base);
  assert.ok(result.currentSnapshot.sources.length < result.snapshot.sources.length);
  result.snapshot.sources[0].version.revision = 99;
  assert.equal(result.currentSnapshot.sources[0].version.revision, 1);
  result.snapshot.sources[0].version.revision = 1;
  assert.deepEqual(result.snapshot.sources.slice(base.sources.length).map(source => source.sourceId), ['daily/2026-11-01.md', 'daily/2026-10-10.md']);
  assert.ok(result.snapshot.sources.slice(base.sources.length).every(source => source.writable === false && source.role === 'daily'));
  assert.equal(f.lists.filter(path => path === pathOf('daily')).length, 1);
  assert.ok(f.lists.every(path => [pathOf('daily'), pathOf('ideas')].includes(path)));
  assert.ok(f.reads.every(read => !/archive|dreams|state/u.test(read.path)));
  assert.equal(result.coverage.dailyFilesDiscovered, 2);
  assert.equal(result.coverage.dailyFilesRead, 2);
  assert.equal(result.coverage.dailyFilesOmitted, 0);
  assert.equal(result.coverage.bytesRead, Buffer.byteLength(entries['2026-11-01.md'] + entries['2026-10-10.md']));
  assert.equal(result.coverage.truncated, false);
  assert.match(result.coverage.meaning, /not new factual authority/u);
});

test('zero history disables extension, preserves current materials, and discloses historical omissions', async () => {
  const f = fixture({ '2026-11-04.md': 'Current.', '2026-10-01.md': 'Old.' });
  const base = await collectSnapshot(f.files, config, scope, options);
  f.reads.length = 0;
  const result = await collect(f, { recallHistoryDays: 0 });
  assert.deepEqual(result.snapshot, base);
  assert.equal(result.coverage.dailyFilesRead, 0);
  assert.equal(result.coverage.bytesRead, 0);
  assert.equal(omission(result, 'daily/2026-10-01.md'), 'history-disabled');
  assert.ok(!f.reads.some(read => read.path.endsWith('2026-10-01.md')));
});

test('strict true-calendar dates, inclusive lookback, two-digit years and future exclusion', async () => {
  const f = fixture({ '2026-11-01.md': 'Inside.', '26-10-31.md': 'Boundary.', '2026-10-30.md': 'Too old.',
    '2026-11-05.md': 'Future.', '2026-02-30.md': 'Impossible.', '2025-02-29.md': 'Not leap.',
    '2026-13-01.md': 'Bad month.', '0000-01-01.md': 'No year zero.', '2026-1-01.md': 'Bad format.', 'notes.md': 'Not date.', '2026-10-31.MD': 'Case not accepted.' });
  const result = await collect(f, { recallHistoryDays: 4 });
  assert.deepEqual(historical(result).map(source => source.path), ['daily/2026-11-01.md', 'daily/26-10-31.md']);
  assert.equal(omission(result, 'daily/26-10-31.md'), undefined);
  assert.equal(omission(result, 'daily/2026-10-30.md'), 'outside-lookback');
  assert.equal(omission(result, 'daily/2026-11-05.md'), 'future-date');
  for (const name of ['2026-02-30.md', '2025-02-29.md', '2026-13-01.md', '0000-01-01.md', '2026-1-01.md', 'notes.md']) {
    assert.equal(omission(result, `daily/${name}`), 'invalid-calendar-filename');
  }
  assert.equal(result.coverage.dailyFilesDiscovered, 10);
  assert.equal(result.coverage.dailyFilesDiscovered, result.coverage.dailyFilesRead + result.coverage.dailyFilesOmitted);
  const leap = fixture({ '2024-02-29.md': 'Leap day.' });
  assert.equal((await collect(leap, { recallHistoryDays: 3650 })).coverage.dailyFilesRead, 1);
});

test('local calendar rather than UTC elapsed hours decides range across DST and date boundaries', async () => {
  const f = fixture({ '2026-10-31.md': 'Boundary.', '2026-10-30.md': 'Outside.', '2026-11-04.md': 'Local future.' });
  const localNow = new Date('2026-11-04T00:30:00.000Z'); // Still November 3 in New York.
  const result = await collect(f, { timeZone: 'America/New_York', recallHistoryDays: 3 }, { ...options, now: localNow });
  assert.equal(omission(result, 'daily/2026-11-04.md'), 'future-date');
  assert.equal(omission(result, 'daily/2026-10-30.md'), 'outside-lookback');
  assert.equal(result.snapshot.sources.find(source => source.path === 'daily/2026-10-31.md').content, 'Boundary.');
});

test('newest date and exact path order are deterministic, independent of listing order', async () => {
  const files = { '26-10-31.md': 'Two-digit.', '2026-10-30.md': 'Older.', '2026-10-31.md': 'Four-digit.', '2026-11-01.md': 'Newest.' };
  const left = fixture(files), right = fixture(files);
  right.listings.get(pathOf('daily')).reverse();
  const [a, b] = await Promise.all([collect(left, { maxRecallFiles: 2 }), collect(right, { maxRecallFiles: 2 })]);
  assert.deepEqual(a, b);
  assert.deepEqual(historical(a).map(source => source.path), ['daily/2026-11-01.md', 'daily/2026-10-31.md']);
  assert.equal(a.coverage.dailyFilesRead, 2);
  assert.equal(a.coverage.dailyFilesOmitted, 2);
  assert.equal(a.coverage.maxFiles, 2);
  assert.ok(a.coverage.omissions.every(item => item.reason === 'history-file-budget'));
  assert.equal(left.reads.filter(read => read.path.includes('/daily/')).length, 2);
});

test('UTF-8 historical byte budget excludes base costs and skips whole oversized files', async () => {
  const f = fixture({ '2026-11-01.md': '鲸'.repeat(200), '2026-10-31.md': '鲸'.repeat(160), '2026-10-30.md': '鲸'.repeat(11), '2026-10-29.md': '鲸'.repeat(10) });
  const result = await collect(f, { maxRecallBytes: 512 });
  assert.deepEqual(historical(result).map(source => source.path), ['daily/2026-10-31.md', 'daily/2026-10-29.md']);
  assert.equal(result.coverage.bytesRead, 510);
  assert.equal(result.coverage.maxBytes, 512);
  assert.equal(omission(result, 'daily/2026-11-01.md'), 'history-byte-budget');
  assert.equal(omission(result, 'daily/2026-10-30.md'), 'history-byte-budget');
  assert.deepEqual(f.reads.filter(read => read.path.includes('/daily/')).map(read => read.maxBytes), [512, 32]);
  assert.equal(historical(result)[0].content.length, 160);
});

test('single-file byte ceiling and unknown stat size retain bounded one-shot reads', async () => {
  const f = fixture({ '2026-11-01.md': 'a'.repeat(101), '2026-10-31.md': 'a'.repeat(80), '2026-10-30.md': 'small' });
  const stat = f.files.stat;
  f.files.stat = async path => {
    const result = await stat(path);
    if (path.endsWith('2026-10-31.md')) delete result.size;
    return result;
  };
  const result = await collect(f, { maxSourceBytes: 100 });
  assert.equal(omission(result, 'daily/2026-11-01.md'), 'source-byte-budget');
  assert.ok(!f.reads.some(read => read.path.endsWith('2026-11-01.md')));
  assert.equal(f.reads.find(read => read.path.endsWith('2026-10-31.md')).maxBytes, 100);
  assert.equal(result.coverage.dailyFilesRead, 2);
});

test('growth, vanished files and known unreadable failures are whole omissions without retries', async () => {
  const f = fixture({ '2026-11-01.md': 'grow', '2026-10-31.md': 'gone', '2026-10-30.md': 'io', '2026-10-29.md': 'race', '2026-10-28.md': 'Good.' });
  const attempts = [], read = f.files.read;
  f.files.read = async (path, opts) => {
    attempts.push(path);
    if (path.endsWith('2026-11-01.md')) throw error('FS_TOO_LARGE');
    if (path.endsWith('2026-10-31.md')) return null;
    if (path.endsWith('2026-10-30.md')) throw error('EIO');
    if (path.endsWith('2026-10-29.md')) throw error('FS_STALE_VERSION');
    return read(path, opts);
  };
  const result = await collect(f);
  assert.equal(result.coverage.dailyFilesRead, 1);
  assert.equal(omission(result, 'daily/2026-11-01.md'), 'read-byte-budget');
  assert.equal(omission(result, 'daily/2026-10-31.md'), 'missing');
  assert.equal(omission(result, 'daily/2026-10-30.md'), 'unreadable');
  assert.equal(omission(result, 'daily/2026-10-29.md'), 'changed-during-read');
  assert.equal(new Set(attempts).size, attempts.length);
});

test('metadata missing, non-file and invalid size never fall back to reads', async () => {
  const f = fixture({ '2026-11-01.md': 'missing', '2026-10-31.md': 'not-file', '2026-10-30.md': 'dir', '2026-10-29.md': 'bad-size', '2026-10-28.md': 'Good.' });
  const stat = f.files.stat;
  f.files.stat = async path => {
    if (path.endsWith('2026-11-01.md')) return null;
    if (path.endsWith('2026-10-31.md')) return { type: 'symlink' };
    if (path.endsWith('2026-10-30.md')) return { type: 'directory' };
    if (path.endsWith('2026-10-29.md')) return { type: 'file', size: -1 };
    return stat(path);
  };
  const result = await collect(f);
  assert.equal(result.coverage.dailyFilesRead, 1);
  assert.equal(f.reads.filter(read => read.path.includes('/daily/')).length, 1);
  assert.equal(omission(result, 'daily/2026-10-31.md'), 'not-regular-file');
  assert.equal(omission(result, 'daily/2026-10-29.md'), 'invalid-size-metadata');
});

test('permission, sandbox, cancellation and unknown failures propagate unchanged with no retry', async () => {
  for (const code of ['EACCES', 'EPERM', 'FS_ACCESS_DENIED', 'SANDBOX_DENIED', 'PATH_NOT_ALLOWED', 'ABORT_ERR', 'UNKNOWN']) {
    for (const method of ['stat', 'read']) {
      const f = fixture({ '2026-11-01.md': 'Denied.', '2026-10-31.md': 'Never retried elsewhere.' });
      const original = f.files[method], denial = error(code); let attempts = 0;
      f.files[method] = async (path, ...args) => {
        if (path.endsWith('2026-11-01.md')) { attempts++; throw denial; }
        return original(path, ...args);
      };
      await assert.rejects(collect(f), actual => actual === denial);
      assert.equal(attempts, 1);
      assert.ok(!f.reads.some(read => read.path.endsWith('2026-10-31.md')));
    }
  }
});

test('base collection failures retain original fail semantics rather than become partial historical success', async () => {
  const missing = fixture({ '2026-11-01.md': 'Historical.' });
  missing.filesByPath.delete(pathOf('long-term.md'));
  await assert.rejects(collect(missing), /Missing configured source: long-term.md/u);
  assert.ok(!missing.reads.some(read => read.path.endsWith('2026-11-01.md')));
  const oversized = fixture({ '2026-11-04.md': 'x'.repeat(100) });
  await assert.rejects(collect(oversized, { maxSourceBytes: 50 }), /Material budget exceeded/u);
  const denied = fixture(); const denial = error('FS_ACCESS_DENIED'); let listings = 0;
  denied.files.list = async () => { listings++; throw denial; };
  await assert.rejects(collect(denied), actual => actual === denial);
  assert.equal(listings, 1);
});

test('strict basename guard blocks traversal, directories and long metadata before stat/read', async () => {
  const f = fixture({ '2026-11-01.md': 'Good.' });
  const names = ['../2026-11-04.md', 'nested/2026-11-01.md', '..\\2026-11-01.md', '/2026-11-01.md', '2026-11-01\u0000.md', `${'鲸'.repeat(500)}.md`];
  f.listings.get(pathOf('daily')).push(...names.map(entry), { name: 'nested', isDirectory: true }, entry('2026-11-01.md'));
  const result = await collect(f);
  assert.equal(result.coverage.dailyFilesRead, 1);
  assert.equal(result.coverage.dailyFilesDiscovered, 7);
  assert.ok(f.stats.every(path => path === pathOf('daily') || path === pathOf('ideas') || f.filesByPath.has(path)));
  assert.ok(result.coverage.omissions.every(item => item.reason === 'unsafe-or-oversized-filename'));
  assert.equal(result.coverage.omittedDiagnostics, 1);
  assert.ok(!JSON.stringify(result.coverage).includes('鲸'.repeat(100)));
});

test('omission diagnostics are bounded whole records and counters never claim complete coverage', async () => {
  const f = fixture();
  f.listings.get(pathOf('daily')).push(...Array.from({ length: 100 }, (_, i) => entry(`${'x'.repeat(400)}-${i}.md`)));
  const result = await collect(f);
  assert.equal(result.coverage.dailyFilesDiscovered, 100);
  assert.equal(result.coverage.dailyFilesOmitted, 100);
  assert.equal(result.coverage.truncated, true);
  assert.ok(result.coverage.omissions.length <= 64);
  assert.ok(Buffer.byteLength(JSON.stringify(result.coverage)) < 18000);
  assert.equal(result.coverage.omissions.length + result.coverage.omittedDiagnostics, 100);
  for (const item of result.coverage.omissions) assert.ok(item.sourceId.endsWith('.md') && Buffer.byteLength(JSON.stringify(item)) <= 1024);
});

test('historical source sensitivity, protection, content and versions always come from the current read', async () => {
  const text = '<!-- sensitive -->\n## 红线\nSynthetic protected line.\n## 日常\nSynthetic raw current event.';
  const f = fixture({ '2026-10-01.md': text });
  const first = await collect(f);
  const historicalSource = historical(first)[0];
  assert.equal(historicalSource.content, text);
  assert.equal(historicalSource.sensitivity, 'sensitive');
  assert.equal(historicalSource.writable, false);
  assert.deepEqual(historicalSource.protectedText, protectedText(text, 'daily'));
  f.filesByPath.set(pathOf('daily/2026-10-01.md'), { content: 'Synthetic revised current event.', version: { revision: 2 } });
  const second = await collect(f);
  assert.equal(historical(second)[0].content, 'Synthetic revised current event.');
  assert.deepEqual(historical(second)[0].version, { revision: 2 });
  assert.equal(historicalSource.content, text);
  historical(second)[0].version.revision = 999;
  assert.equal(f.filesByPath.get(pathOf('daily/2026-10-01.md')).version.revision, 2);
});

test('a backend violating its bounded-read contract is disclosed, omitted whole and stops exhausted-byte reads', async () => {
  const f = fixture({ '2026-11-01.md': 'small-stat', '2026-10-31.md': 'Never read after exhaustion.' });
  const read = f.files.read;
  f.files.read = async (path, opts) => path.endsWith('2026-11-01.md') ? { content: '鲸'.repeat(200), version: 2 } : read(path, opts);
  const result = await collect(f, { maxRecallBytes: 512 });
  assert.equal(result.coverage.bytesRead, 600);
  assert.equal(result.coverage.dailyFilesRead, 0);
  assert.equal(omission(result, 'daily/2026-11-01.md'), 'backend-read-budget-exceeded');
  assert.equal(omission(result, 'daily/2026-10-31.md'), 'history-byte-budget');
  assert.ok(!f.reads.some(read => read.path.endsWith('2026-10-31.md')));
});

test('invalid historical options and returned versions fail before yielding usable sources', async () => {
  for (const override of [{ recallHistoryDays: -1 }, { recallHistoryDays: 3651 }, { recallHistoryDays: 1.5 },
    { maxRecallFiles: 0 }, { maxRecallFiles: 1025 }, { maxRecallBytes: 0 }, { maxRecallBytes: 8388609 }]) {
    const f = fixture(); await assert.rejects(collect(f, override), TypeError); assert.equal(f.lists.length, 0);
  }
  const f = fixture({ '2026-11-01.md': 'Invalid version.' });
  f.filesByPath.get(pathOf('daily/2026-11-01.md')).version = undefined;
  await assert.rejects(collect(f), /version must be a JSON value/u);
});
