import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { createEngine } from '../dist/engine.js';
import { createInternalTurnCompletion } from '../dist/harness/internal-turns.js';
import { createStore } from '../dist/storage/index.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

// These are orchestration regressions with actual confined file transactions.
// The fake Host does not prove native compaction, model quality, or concurrency.
async function fixture(t, compact) {
  const generated = fileURLToPath(new URL('./.tmp/', import.meta.url));
  await mkdir(generated, { recursive: true });
  const root = await mkdtemp(join(generated, 'compaction-interleave-'));
  const local = createLocalFiles(root), writes = [], reads = [];
  const relativePath = path => isAbsolute(path) ? relative(root, path) : path;
  const files = {
    ...local,
    read(path, options) { reads.push(path); return local.read(relativePath(path), options); },
    stat: path => local.stat(relativePath(path)),
    list: path => local.list(relativePath(path)),
    mkdir: path => local.mkdir(relativePath(path)),
    async write(path, content, version) {
      const written = await local.write(relativePath(path), content, version);
      writes.push(relativePath(path)); return written;
    },
  };
  const config = validateConfig({ sessionId: 'synthetic-compaction', memoryRoot: join(root, 'memory'), stateRoot: join(root, 'state'),
    timeZone: 'Asia/Tokyo', compactionMode: 'auto', dreamMode: 'off' });
  const actor = { agentId: config.sessionId, sessionId: config.sessionId };
  const scope = { scopeId: config.sessionId, ...actor, memoryRootId: config.memoryRoot };
  const clock = new Date('2026-11-05T05:30:00+09:00');
  const initial = '# Synthetic memory\nOriginal note.\n';
  const daily = 'Synthetic event: Alpha completed. Synthetic event: Beta completed.\n';
  for (const dir of ['daily', 'ideas']) await files.mkdir(join(config.memoryRoot, dir));
  for (const [path, content] of [['long-term.md', initial], ['decisions.md', '# Synthetic decisions\n'], ['journal.md', '# Synthetic journal\n'], ['daily/2026-11-05.md', daily]]) {
    await files.write(join(config.memoryRoot, path), content, null);
  }
  const dailyPath = join(config.memoryRoot, 'daily/2026-11-05.md');
  const originalDaily = await files.read(dailyPath);
  const memoryPath = join(config.memoryRoot, 'long-term.md');
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot, now: () => clock.toISOString() });
  const calls = { generate: 0, cleanReview: 0, maintain: 0, compact: 0, reload: [], notify: [] };
  const controller = new AbortController();
  let sequence = 0;
  const host = {
    async waitForIdle() {},
    async maintain(work) { calls.maintain++; return work(controller.signal); },
    async compact(signal) { calls.compact++; return compact(calls.compact, signal); },
    async requestReview() {},
    async requestReload(text, metadata) { calls.reload.push({ text, metadata }); },
    async notify(text, metadata) { calls.notify.push({ text, metadata }); },
  };
  const engine = createEngine({ config, scope, files, store, host, signal: controller.signal,
    now: () => new Date(clock), id: () => `interleave-${++sequence}`,
    cleanReview: async (snapshot, proposal) => {
      calls.cleanReview++;
      return { decision: 'accept', reason: 'Synthetic independent original-evidence check.', authority: syntheticCleanAuthority(snapshot, proposal, { callId: `synthetic-clean-${calls.cleanReview}` }) };
    },
    generate: async (snapshot, jobId) => {
      calls.generate++;
      return { mode: 'memory-v2', proposals: ['Alpha', 'Beta'].map((name, index) => ({ schemaVersion: 1, jobId, proposalId: `${jobId}-${index + 1}`, kind: 'fact',
        text: `Synthetic ${name} completed.`, reason: 'Explicit synthetic daily record.', targetId: 'long-term.md', operation: 'append', before: '', after: `- Synthetic ${name} completed.\n`,
        evidence: [{ sourceId: 'daily/2026-11-05.md', quote: `Synthetic event: ${name} completed.` }],
        consolidation: { action: 'add', claimKey: `synthetic-${name.toLowerCase()}-completion`, applicability: { topic: 'synthetic experiments', conditions: `only the ${name} experiment` }, basis: 'observation' },
      })), digest: { schemaVersion: 1, snapshotId: snapshot.snapshotId,
        episodes: [{ episodeId: `${jobId}-event-1`, summary: 'Two synthetic completions.', when: '2026-11-05', participants: [], status: 'reported', category: 'future-useful', importanceReason: 'Preserve the two concrete recorded events.', retention: 'recent', evidence: [{ sourceId: 'daily/2026-11-05.md', quote: daily.trim() }] }],
        coverage: { sourceIds: ['daily/2026-11-05.md'], omittedSourceIds: snapshot.sources.filter(source => source.sourceId !== 'daily/2026-11-05.md').map(source => source.sourceId) },
      } };
    },
  });
  t.after(async () => { controller.abort(new Error('Synthetic test cleanup')); await engine.flush(); });
  writes.length = 0; reads.length = 0;
  async function generateAndReview() {
    const job = await engine.dream();
    const review = await engine.reviewBatch({ jobId: job.jobId, proposalIds: job.proposals.map(proposal => proposal.proposalId) }, { actor });
    assert.equal(review.results.length, 2);
    assert.ok(review.results.every(result => result.decision === 'accept'));
    assert.deepEqual(review.remainingUnreviewedIds, []);
    return job;
  }
  async function readReady(jobId) {
    const job = await store.loadJob(jobId);
    assert.equal(job.state, 'awaiting_reload');
    const result = await engine.readReload({ jobId, transactionId: job.reload.transactionId }, { actor, callId: 'synthetic-native-read' });
    assert.deepEqual(result.remainingSourceIds, []);
    assert.equal(result.sources.length, job.reload.sources.length);
    for (const source of result.sources) assert.deepEqual(await files.read(source.path), { content: source.content, version: source.version });
    return { job, result };
  }
  return { files, store, engine, config, actor, calls, writes, reads, initial, memoryPath, dailyPath, originalDaily, generateAndReview, readReady };
}

test('deferred busy compaction retries only compaction after a batch commit and completes through actual read tokens', async t => {
  const firstEntered = deferred(), firstResult = deferred(), secondEntered = deferred(), secondResult = deferred();
  const f = await fixture(t, async number => {
    if (number === 1) { firstEntered.resolve(); return firstResult.promise; }
    assert.equal(number, 2, 'No third compaction may be dispatched');
    secondEntered.resolve(); return secondResult.promise;
  });
  t.after(() => { firstResult.resolve(null); secondResult.resolve(null); });
  const job = await f.generateAndReview();
  await firstEntered.promise;
  const applying = await f.store.loadJob(job.jobId);
  assert.equal(applying.state, 'compacting');
  assert.equal(applying.appliedProposalIds.length, 2);
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.reload.length, 0);
  assert.equal(applying.transactionHistory, undefined);
  const committed = await f.files.read(f.memoryPath);
  const transactionId = applying.transaction.transactionId;
  const frozenReviews = structuredClone(applying.reviews);
  f.engine.submit({ jobId: job.jobId });
  assert.equal(f.calls.compact, 1, 'Repeated submit cannot dispatch another running compaction');
  firstResult.reject(Object.assign(new Error('Synthetic Host is busy'), { code: 'busy' }));
  await f.engine.flush();
  const waiting = await f.store.loadJob(job.jobId);
  assert.equal(waiting.state, 'awaiting_compaction');
  assert.equal(waiting.compactionAttempts, 1);
  assert.equal(f.calls.notify.length, 0);
  const same = await f.engine.dream();
  assert.ok(same.reused || same.reason === 'no_new_material');
  assert.equal(f.calls.generate, 1);
  await f.engine.retry({ jobId: job.jobId });
  await secondEntered.promise;
  assert.deepEqual(await f.files.read(f.memoryPath), committed);
  assert.equal(f.calls.cleanReview, 2);
  assert.equal(f.calls.maintain, 1);
  secondResult.resolve({ compactionId: 'synthetic-compaction-success' });
  await f.engine.flush();
  const { job: ready, result } = await f.readReady(job.jobId);
  assert.deepEqual(ready.compaction, { status: 'completed', compactionId: 'synthetic-compaction-success' });
  assert.equal(ready.transaction.transactionId, transactionId);
  assert.deepEqual(ready.reviews, frozenReviews);
  assert.equal(ready.reload.acknowledgedAt, undefined);
  const ack = await f.engine.ackReload({ jobId: job.jobId, transactionId, readReceiptIds: [result.readReceiptId] }, { actor: f.actor, callId: 'synthetic-native-ack' });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.report.state, 'sent');
  const complete = await f.store.loadJob(job.jobId);
  assert.equal(complete.state, 'completed');
  assert.equal(complete.transactionHistory.length, 1);
  assert.equal(complete.transactionHistory[0].transaction.transactionId, transactionId);
  assert.equal((await f.store.listTransactions()).length, 1);
  assert.equal(f.writes.filter(path => path === 'memory/long-term.md').length, 1);
  assert.equal(f.calls.generate, 1); assert.equal(f.calls.cleanReview, 2); assert.equal(f.calls.compact, 2);
  assert.deepEqual(await f.files.read(f.dailyPath), f.originalDaily);
});

test('no-op compaction still requires complete reads and a session-only checkpoint does not invalidate engine receipts', async t => {
  const f = await fixture(t, async () => null);
  const job = await f.generateAndReview(); await f.engine.flush();
  const ready = await f.store.loadJob(job.jobId);
  assert.equal(ready.state, 'awaiting_reload');
  assert.deepEqual(ready.compaction, { status: 'no_op' });
  assert.equal(ready.reload.acknowledgedAt, undefined);
  assert.equal(ready.transactionHistory, undefined);
  await assert.rejects(f.engine.ackReload({ jobId: job.jobId, transactionId: ready.reload.transactionId, readReceiptIds: ['unissued-token'] }, { actor: f.actor, callId: 'bad-ack' }), /Unknown/);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_reload');
  const { result } = await f.readReady(job.jobId);

  // Model a session-surface replacement through the tracker's actual public-event
  // seam. This is deliberately NOT a native compaction service or log write.
  const listeners = new Map();
  const session = { id: f.actor.sessionId };
  const agent = { id: f.actor.agentId, session };
  const tracker = createInternalTurnCompletion({ on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name); } }, agent);
  t.after(() => tracker.dispose());
  const metadata = f.calls.reload[0].metadata;
  const notification = { id: metadata.messageId, role: 'user', content: [{ type: 'text', text: f.calls.reload[0].text }], source: { kind: 'dsh-dream', purpose: 'reload', jobId: job.jobId, transactionId: ready.reload.transactionId } };
  tracker.expect(notification);
  listeners.get('agent/inbox/claimed')({ agent, turn: 1, message: notification });
  await listeners.get('agent/pre-step')({ agent, turn: 1, step: 1, messages: [notification] }, async () => ({ kind: 'enter', messages: [notification] }));
  const frozenState = await f.store.loadJob(job.jobId);
  listeners.get('session/event')(session, { type: 'user/message', data: { id: 'synthetic-checkpoint', role: 'user', source: { kind: 'synthetic-session-replacement' }, content: [{ type: 'text', text: 'A synthetic summary of earlier conversation, not evidence.' }] } });
  assert.deepEqual(await f.store.loadJob(job.jobId), frozenState, 'Session-only checkpoint must not mutate persisted job/transaction/receipt basis');
  listeners.get('session/event')(session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'native-ack', name: 'dream_ack_reload' }] } } });
  const args = { jobId: job.jobId, transactionId: ready.reload.transactionId, readReceiptIds: [result.readReceiptId] };
  const ack = await f.engine.ackReload(args, { actor: f.actor, callId: 'native-ack' });
  let concluded = false;
  assert.equal(tracker.finish('dream_ack_reload', args, ack, { agent, callId: 'native-ack', concludeTurn() { concluded = true; } }), false);
  assert.equal(concluded, false, 'Mixed checkpoint turn fails open; successful ACK is not permission to suppress other context');
  assert.equal(ack.acknowledged, true);
  const complete = await f.store.loadJob(job.jobId);
  assert.equal(complete.state, 'completed');
  assert.equal(complete.transactionHistory.length, 1);
  assert.match(f.calls.notify[0].text, /无操作/);
  assert.equal(f.calls.compact, 1); assert.equal(f.calls.generate, 1); assert.equal(f.calls.cleanReview, 2);
  assert.equal(f.writes.filter(path => path === 'memory/long-term.md').length, 1);
  assert.deepEqual(await f.files.read(f.dailyPath), f.originalDaily);
});
