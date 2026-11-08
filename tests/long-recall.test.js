import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectSnapshot } from '../dist/dream/materials.js';
import { collectRecallSnapshot } from '../dist/dream/recall-materials.js';
import { recallMemory } from '../dist/dream/recall.js';
import { validateConfig } from '../dist/config.js';

function fixture(configPatch = {}) {
  const root = '/synthetic/long-memory', data = new Map(), reads = [], writes = [];
  let revision = 0;
  const put = (path, content) => { data.set(`${root}/${path}`, { content, version: ++revision }); };
  for (const [p, text] of [['long-term.md', '# Synthetic durable facts\nThe blue notebook belongs to Lin.\n'], ['decisions.md', '# Synthetic decisions\n'], ['journal.md', '# Synthetic journal\n'], ['daily/2026-10-01.md', 'Synthetic: Mei said the silver key was in the red box.\n'], ['daily/2026-10-08.md', 'Synthetic direct correction: The silver key is in the green drawer, not the red box. The earlier location was mistaken.\n'], ['daily/2026-10-10.md', 'Synthetic: We agreed to inspect ticket ZQ42 Friday evening; the exact time was not decided. No completion has been recorded.\n'], ['ideas/open.md', 'Synthetic: It is not confirmed whether Tao was angry.\n'], ['dreams/26-10-10.md', '> Dream; not factual evidence. The silver key cost 98989 yuan and grew wings.\n'], ['archive/unreviewed.md', 'Unreviewed note: The key was in the black bag.\n']]) put(p, text);
  for (let day = 11; day <= 30; day++) put(`daily/2026-10-${day}.md`, `Synthetic ordinary weather entry ${day}: clouds over the canal.\n`);
  const files = {
    async read(path) { reads.push(path); return data.has(path) ? structuredClone(data.get(path)) : null; },
    async stat(path) { if ([root, `${root}/daily`, `${root}/ideas`].includes(path)) return { type: 'directory' }; const f = data.get(path); return f ? { type: 'file', size: Buffer.byteLength(f.content), version: f.version } : null; },
    async list(path) { return [...data.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')).map(p => ({ name: p.slice(path.length + 1), isDirectory: false })); },
    async write() { writes.push('UNEXPECTED_WRITE'); throw new Error('Read only recall'); }, async mkdir() {}, async withLock(_key, work) { return work(); },
  };
  const config = validateConfig({ sessionId: 'synthetic-session', memoryRoot: root, stateRoot: '/synthetic/state', timeZone: 'Asia/Tokyo', ...configPatch });
  const scope = { scopeId: 'synthetic-scope', sessionId: config.sessionId, agentId: config.sessionId, memoryRootId: root };
  const now = new Date('2026-10-31T12:00:00+09:00');
  const collect = () => collectRecallSnapshot(files, config, scope, { now, snapshotId: 'cold-month' });
  const search = (c, query) => recallMemory(c.snapshot, [], [], { query, topic: 'synthetic prior events', conditions: 'Only what current files record', limit: 4 }, { now, boost: 0, materials: c.coverage, reinforcementBasis: c.currentSnapshot });
  return { root, data, reads, writes, put, files, config, scope, now, collect, search };
}

test('month-later recall finds a concrete older commitment amid three weeks of distractors without changing generation inputs', async () => {
  const f = fixture(); const base = await collectSnapshot(f.files, f.config, f.scope, { now: f.now, snapshotId: 'generation' });
  assert.equal(base.sources.some(s => s.sourceId === 'daily/2026-10-10.md'), false);
  const cold = await f.collect(); const result = f.search(cold, 'ticket ZQ42 Friday');
  assert.ok(result.hits.some(h => h.text.includes('exact time was not decided') && h.text.includes('No completion has been recorded')));
  const hit = result.hits.find(h => h.sourceId === 'daily/2026-10-10.md'); assert.equal(hit.temporalStatus, 'dated-record-not-current-status');
  assert.equal(hit.reinforcementBoost, 0); assert.deepEqual(f.writes, []);
});

test('old and newer contradictory raw records are both dated evidence, never silently synthesized into a trusted answer', async () => {
  const f = fixture(); const result = f.search(await f.collect(), 'silver key red green location');
  assert.ok(result.hits.some(h => h.sourceId === 'daily/2026-10-01.md'));
  assert.ok(result.hits.some(h => h.sourceId === 'daily/2026-10-08.md' && h.text.includes('direct correction')));
  assert.ok(result.hits.every(h => !('truth' in h) && h.reinforcementBoost === 0));
  assert.equal(result.hits.some(h => h.text.includes('98989') || h.text.includes('black bag')), false);
  assert.equal(f.reads.some(p => /dreams|archive|state/u.test(p)), false);
});

test('historical recall reopens current bytes and versions, never saved results, removed sources or restored authority', async () => {
  const f = fixture(); const first = f.search(await f.collect(), 'ticket ZQ42'); const hit = first.hits.find(h => h.sourceId === 'daily/2026-10-10.md');
  f.put('daily/2026-10-10.md', 'Synthetic update: Ticket ZQ42 was cancelled on 2026-10-12; this is not a completed inspection.\n');
  const second = f.search(await f.collect(), 'ticket ZQ42'); const current = second.hits.find(h => h.sourceId === hit.sourceId);
  assert.ok(current.text.includes('cancelled')); assert.notDeepEqual(current.version, hit.version); assert.notEqual(current.proof.contentHash, hit.proof.contentHash);
  f.data.delete(`${f.root}/daily/2026-10-10.md`); const third = f.search(await f.collect(), 'ticket ZQ42'); assert.equal(third.hits.length, 0);
  assert.ok(first.hits[0].text.includes('Friday')); assert.deepEqual(f.writes, []);
});

test('query results disclose lookback and file-budget omissions instead of treating a cold miss as absence', async () => {
  const f = fixture({ maxRecallFiles: 2 }); const cold = await f.collect(); const miss = f.search(cold, 'ticket ZQ42');
  assert.equal(miss.hits.length, 0); assert.equal(miss.coverage.materials.truncated, true); assert.equal(miss.coverage.materials.dailyFilesRead, 2);
  assert.ok(miss.coverage.materials.omissions.some(o => o.sourceId === 'daily/2026-10-10.md' && o.reason === 'history-file-budget'));
  for (const source of cold.snapshot.sources) assert.equal(createHash('sha256').update(source.content).digest('hex').length, 64);
});
