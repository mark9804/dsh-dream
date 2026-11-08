import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

// Scripted model/authority, actual confined files/engine/transaction: not a
// substitute for the separately archived real Host/model trial.
test('merge and correction actually commit then drive scoped recall while independent events and raw diaries remain unchanged', async () => {
  const tmp = fileURLToPath(new URL('./.tmp/', import.meta.url)); await mkdir(tmp, { recursive: true }); const root = await mkdtemp(join(tmp, 'closed-recall-'));
  const local = createLocalFiles(root), path = p => isAbsolute(p) ? relative(root, p) : p;
  const files = { ...local, read: (p, o) => local.read(path(p), o), write: (p, c, v) => local.write(path(p), c, v), mkdir: p => local.mkdir(path(p)), stat: p => local.stat(path(p)), list: p => local.list(path(p)) };
  const config = validateConfig({ sessionId: 'synthetic-closed', memoryRoot: join(root, 'memory'), stateRoot: join(root, 'state'), timeZone: 'Asia/Tokyo', dreamMode: 'off', compactionMode: 'agent', reinforcementBoost: 0 });
  const scope = { scopeId: config.sessionId, agentId: config.sessionId, sessionId: config.sessionId, memoryRootId: config.memoryRoot }, actor = { agentId: config.sessionId, sessionId: config.sessionId };
  const beforeTrip = '- Synthetic trip: changes are fine; no delegated extra meetings.\n- Synthetic trip: flexible plans, never accept extra meetings for me.\n';
  const afterTrip = '- Synthetic trip only: changes are fine; no delegated extra meetings.\n';
  const beforeCup = '- Synthetic amber pot origin: market purchase.\n', afterCup = '- Synthetic amber pot origin: gift from Cousin; old market-purchase entry corrected.\n';
  const events = '\n- 2026-10-29 Synthetic lamp counting: Lin felt calm.\n- 2026-11-02 Synthetic lamp counting: Lin felt worried.\n';
  const diary = 'Synthetic direct request: Those two trip statements express the same boundary; keep changes allowed and no delegated extra meetings, only on trips.\n\nSynthetic direct correction: The amber pot was a gift from Cousin, not a market purchase.\n';
  for (const d of ['daily', 'ideas']) await files.mkdir(join(config.memoryRoot, d));
  for (const [p, text] of [['long-term.md', '# Synthetic\n\n' + beforeTrip + '\n' + beforeCup + events], ['decisions.md', '# Synthetic decisions\n'], ['journal.md', '# Synthetic source index\n'], ['daily/2026-11-05.md', diary], ['daily/2026-10-29.md', Array.from({ length: 20 }, () => 'Synthetic amber pot origin: market purchase.').join('\n\n')]]) await files.write(join(config.memoryRoot, p), text, null);
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot }); let clock = new Date('2026-11-05T05:30:00+09:00');
  const generate = async (_snapshot, jobId) => ({ dream: 'Legacy fixture narrative, never used as evidence.', proposals: [
    { schemaVersion: 1, jobId, proposalId: jobId + '-merge', kind: 'preference', text: 'UNTRUSTED merge summary', reason: 'scripted', targetId: 'long-term.md', operation: 'replace', before: beforeTrip, after: afterTrip, evidence: [{ sourceId: 'long-term.md', quote: beforeTrip }, { sourceId: 'daily/2026-11-05.md', quote: diary.split('\n\n')[0] }], consolidation: { action: 'merge', claimKey: 'trip', applicability: { topic: 'trip', conditions: 'only synthetic trips' }, basis: 'explicit' } },
    { schemaVersion: 1, jobId, proposalId: jobId + '-correct', kind: 'fact', text: 'UNTRUSTED correction summary', reason: 'scripted', targetId: 'long-term.md', operation: 'replace', before: beforeCup, after: afterCup, evidence: [{ sourceId: 'long-term.md', quote: beforeCup }, { sourceId: 'daily/2026-11-05.md', quote: diary.split('\n\n')[1].trim() }], consolidation: { action: 'correct', claimKey: 'pot', applicability: { topic: 'pot', conditions: 'only this synthetic pot' }, basis: 'correction' } },
  ] });
  const engine = createEngine({ config, scope, files, store, generate, now: () => new Date(clock), cleanReview: async (snap, p) => ({ decision: 'accept', reason: 'Synthetic independent authority only.', authority: syntheticCleanAuthority(snap, p) }), host: { async waitForIdle() {}, async maintain(fn) { return fn(new AbortController().signal); }, async compact() { assert.fail('must skip real parent compaction'); }, async requestReview() {}, async requestReload() {}, async notify() {} } });
  // Review one at a time while engine auto-submit is held until both complete.
  const job = await engine.dream();
  // Explicit acceptance batching uses the existing store authority records so a
  // fast fixture idle cannot submit half the batch during the second review.
  const { recordReview } = await import('../dist/review/index.js');
  for (const p of job.proposals) await store.updateJob(job.jobId, current => recordReview(current, { jobId: job.jobId, proposalId: p.proposalId, decision: 'accept', reason: 'Synthetic independently checked.' }, actor, { reviewId: p.proposalId + '-review', now: clock.toISOString(), authority: syntheticCleanAuthority(current.snapshot, p) }));
  engine.submit({ jobId: job.jobId }); await engine.flush(); let state = await engine.status({ jobId: job.jobId }); assert.equal(state.state, 'awaiting_compaction');
  await engine.decideCompaction({ jobId: job.jobId, transactionId: state.compactionTransactionId, decision: 'skip', reason: 'Synthetic test only.' }, { actor }); await engine.flush(); state = await engine.status({ jobId: job.jobId });
  for (const s of state.reload.sources) await files.read(s.path);
  await engine.ackReload({ jobId: job.jobId, transactionId: state.reload.transactionId, readSourceIds: state.reload.sources.map(s => s.sourceId) }, { actor }); await engine.flush();
  assert.equal((await engine.status({ jobId: job.jobId })).state, 'completed');
  const written = (await files.read(join(config.memoryRoot, 'long-term.md'))).content;
  assert.ok(written.includes(afterTrip) && !written.includes(beforeTrip)); assert.ok(written.includes(afterCup)); assert.ok(written.includes(events));
  assert.equal((await files.read(join(config.memoryRoot, 'daily/2026-11-05.md'))).content, diary);
  clock = new Date('2026-11-12T05:30:00+09:00');
  const recalled = await engine.recall({ query: 'amber pot market', topic: 'pot', conditions: 'only this synthetic pot', limit: 3 });
  assert.equal(recalled.hits[0].sourceId, 'long-term.md'); assert.equal(recalled.hits[0].consolidation.role, 'current-after-image'); assert.equal(recalled.relations.length, 1); assert.ok(recalled.hits.some(h => h.group?.memberCount === 20));
  assert.ok(recalled.relations[0].after.text.includes('gift from Cousin'));
  assert.equal((await store.loadJob(job.jobId)).transactionHistory.length, 1);
  assert.ok((await store.loadJob(job.jobId)).transactionHistory[0].writtenSources.length > 0);
  const current = await files.read(join(config.memoryRoot, 'long-term.md')); await files.write(join(config.memoryRoot, 'long-term.md'), current.content + '\nExternal unrelated edit.\n', current.version);
  const stale = await engine.recall({ query: 'amber pot market', topic: 'pot', conditions: 'only this synthetic pot', limit: 3 }); assert.equal(stale.relations.length, 0); assert.ok(stale.hits.every(h => !h.consolidation));
});
