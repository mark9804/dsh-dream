import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { localDate } from '../dist/scheduler/window.js';
import { annotateSnapshot } from '../dist/dream/lineage.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const generated = fileURLToPath(new URL('./.tmp/', import.meta.url));
const initialMemory = '# Long-term memory\nA synthetic existing note.\n';

async function fixture(t, overrides = {}) {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'engine-'));
  const local = createLocalFiles(directory);
  const localPath = (path) => isAbsolute(path) ? relative(directory, path) : path;
  const writes = [];
  let storageLockDepth = 0;
  const files = {
    ...local,
    read: (path, options) => local.read(localPath(path), options),
    stat: (path) => local.stat(localPath(path)),
    list: (path) => local.list(localPath(path)),
    mkdir: (path) => local.mkdir(localPath(path)),
    withLock: (key, operation) => local.withLock(key, async () => {
      storageLockDepth++;
      try { return await operation(); } finally { storageLockDepth--; }
    }),
    async write(path, content, version) {
      const result = await local.write(localPath(path), content, version);
      writes.push(localPath(path));
      return result;
    },
  };
  let clock = new Date(2026, 9, 26, 5, 30);
  const config = validateConfig({ sessionId: 'session', memoryRoot: join(directory, 'memory'), stateRoot: join(directory, 'state'),
    personaPath: join(directory, 'persona.md'), ...overrides });
  const scope = { scopeId: 'fixture', agentId: 'session', sessionId: 'session', memoryRootId: config.memoryRoot };
  const actor = { agentId: scope.agentId, sessionId: scope.sessionId };
  await files.mkdir(join(config.memoryRoot, 'daily'));
  await files.mkdir(join(config.memoryRoot, 'ideas'));
  await files.write(join(config.memoryRoot, 'long-term.md'), initialMemory, null);
  await files.write(join(config.memoryRoot, 'decisions.md'), '# Decisions\n', null);
  await files.write(join(config.memoryRoot, 'journal.md'), 'A synthetic journal entry.\n', null);
  if (config.personaPath) await files.write(config.personaPath, '# Synthetic persona\nKeep existing forms of address.\n', null);
  const daily = join(config.memoryRoot, 'daily', `${localDate(clock, 'local')}.md`);
  await files.write(daily, 'The synthetic experiment finished. The user requested concise synthetic replies.\n', null);
  writes.length = 0;
  const store = createStore(files, { root: config.stateRoot, lockKey: scope.memoryRootId, now: () => clock.toISOString() });
  const calls = { generate: 0, compact: [], maintain: 0, review: [], cleanReview: [], reload: [], notify: [], order: [] };
  const compactions = [];
  let idle;
  let release;
  const busy = () => {
    if (!idle) idle = new Promise((resolve) => { release = resolve; });
  };
  const becomeIdle = () => {
    const done = release;
    release = undefined;
    idle = undefined;
    done?.();
  };
  const host = {
    async waitForIdle() { if (idle) await idle; },
    async maintain(work) {
      assert.equal(idle, undefined, 'Memory must not be committed during the review turn');
      calls.maintain++;
      calls.order.push('maintain');
      return work();
    },
    async compact() {
      calls.compact.push('compact');
      calls.order.push('compact');
      const result = compactions.length ? compactions.shift() : { compactionId: `compact-${calls.compact.length}` };
      if (result instanceof Error) throw result;
      return result;
    },
    async requestReview(text, receipt) { calls.review.push({ text, ...receipt }); busy(); },
    async requestReload(text, receipt) { calls.order.push('reload'); calls.reload.push({ text, ...receipt }); },
    async notify(text, receipt) { calls.order.push('notify'); calls.notify.push({ text, ...receipt }); },
  };
  const generate = async (snapshot, jobId) => {
    calls.generate++;
    const sourceId = snapshot.sources.find((source) => source.role === 'daily').sourceId;
    return {
      dream: 'A synthetic dream of a completed experiment and quiet clouds.',
      proposals: [
        { schemaVersion: 1, proposalId: `${jobId}-one`, jobId, kind: 'fact', text: 'The synthetic experiment finished.',
          reason: 'The diary records completion.', evidence: [{ sourceId, quote: 'The synthetic experiment finished.' }],
          targetId: 'long-term.md', operation: 'append', before: '', after: '- Synthetic experiment completed.\n' },
        { schemaVersion: 1, proposalId: `${jobId}-two`, jobId, kind: 'preference', text: 'Use concise synthetic replies.',
          reason: 'The diary records the request.', evidence: [{ sourceId, quote: 'The user requested concise synthetic replies.' }],
          targetId: 'long-term.md', operation: 'append', before: '', after: '- Synthetic preference: concise replies.\n' },
      ],
    };
  };
  let sequence = 0;
  const engines = [];
  const controllers = [];
  const releaseReviewWaits = [];
  // Offline fixtures explicitly supply synthetic authority; production must supply its own reviewer.
  const acceptCleanReview = async (snapshot, proposal) => ({ decision: 'accept', reason: 'Independently checked synthetic sources.',
    authority: syntheticCleanAuthority(snapshot, proposal, { callId: `synthetic-call-${++sequence}` }) });
  let cleanReview = acceptCleanReview;
  const invokeCleanReview = async (...args) => {
    assert.equal(storageLockDepth, 0, 'The isolated model must run without holding the storage lock');
    calls.cleanReview.push(args);
    return cleanReview(...args);
  };
  function newEngine(targetHost = host, reviewer = invokeCleanReview) {
    const controller = new AbortController();
    controllers.push(controller);
    const engine = createEngine({ config, scope, files, store, generate, cleanReview: reviewer, host: targetHost, signal: controller.signal,
      now: () => new Date(clock), id: () => `fixture-${++sequence}` });
    engines.push(engine);
    return engine;
  }
  const engine = newEngine();
  t.after(async () => {
    releaseReviewWaits.forEach(release => release());
    becomeIdle();
    controllers.forEach((controller) => controller.abort(new Error('Fixture cleanup')));
    await Promise.all(engines.map((instance) => instance.flush().catch(() => {})));
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, files, store, config, scope, actor, calls, writes, compactions, daily, host, busy, becomeIdle, newEngine, acceptCleanReview, releaseReviewWaits,
    setCleanReview(reviewer) { cleanReview = reviewer; },
    setTime(hour, minute = 0) { clock = new Date(2026, 9, 26, hour, minute); },
    memory: () => files.read(join(config.memoryRoot, 'long-term.md')) };
}

function reviewRequest(job, index = 0, overrides = {}) {
  return { jobId: job.jobId, proposalId: job.proposals[index].proposalId, decision: 'review',
    reason: 'MAIN_REASON_MUST_NOT_REACH_CLEAN_REVIEW', ...overrides };
}

async function assertNoApproval(f, jobId) {
  const job = await f.store.loadJob(jobId);
  assert.equal(job.reviews.some(review => review.decision === 'accept'), false);
  assert.deepEqual(job.appliedProposalIds, []);
  assert.deepEqual(await f.store.listTransactions(), []);
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal(f.calls.maintain, 0);
  assert.equal(f.calls.compact.length, 0);
}

function pauseCleanReview(f) {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  f.releaseReviewWaits.push(release);
  f.setCleanReview(async (snapshot, proposal, options) => {
    entered({ snapshot, proposal, options });
    await blocked;
    return f.acceptCleanReview(snapshot, proposal);
  });
  return { ready, release };
}

for (const forged of [false, true]) test(`direct engine accept is rejected with zero writes${forged ? ' even with supplied authority' : ''}`, async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  f.writes.length = 0;
  const args = reviewRequest(job, 0, { decision: 'accept', ...(forged ? { authority: syntheticCleanAuthority(job.snapshot, job.proposals[0]) } : {}) });
  await assert.rejects(f.engine.review(args, { actor: f.actor }), /[Dd]irect accept|isolated review/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.calls.cleanReview.length, 0);
  await assertNoApproval(f, job.jobId);
});

test('missing isolated reviewer fails closed without persisting a review or state change', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const engine = f.newEngine(f.host, null);
  f.writes.length = 0;
  await assert.rejects(engine.review(reviewRequest(job), { actor: f.actor }), { code: 'CLEAN_REVIEW_REQUIRED' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.store.loadJob(job.jobId), job);
  await assertNoApproval(f, job.jobId);
});

test('isolated review rereads every source and never receives the main chat reason', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  for (const path of [f.daily, join(f.config.memoryRoot, 'journal.md'), f.config.personaPath]) {
    const source = await f.files.read(path);
    await f.files.write(path, `${source.content}Fresh synthetic context before review.\n`, source.version);
  }
  let received;
  f.setCleanReview(async (...args) => {
    received = args;
    assert.equal(args.length, 3);
    assert.deepEqual(Object.keys(args[2]), ['signal']);
    assert.ok(args[2].signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(args), /MAIN_REASON_MUST_NOT_REACH_CLEAN_REVIEW/);
    for (const role of ['daily', 'journal', 'persona']) assert.match(args[0].sources.find(source => source.role === role).content, /Fresh synthetic context/);
    return f.acceptCleanReview(...args);
  });
  const result = await f.engine.review(reviewRequest(job), { actor: f.actor });
  assert.equal(result.decision, 'accept');
  assert.equal(result.reason, 'Independently checked synthetic sources.');
  assert.notEqual(received[0].snapshotId, job.snapshot.snapshotId);
  const persisted = await f.store.loadJob(job.jobId);
  assert.deepEqual(persisted.snapshot.sources, received[0].sources);
  assert.equal(persisted.reviews[0].authority.callId, result.authority.callId);
  assert.equal((await f.memory()).content, initialMemory, 'Review still waits for the main agent to become idle');
});

for (const sourceKind of ['target', 'evidence', 'uncited journal', 'uncited persona', 'version-only']) {
  test(`${sourceKind} changes during isolated review invalidate acceptance without review writes`, async t => {
    const f = await fixture(t);
    const job = await f.engine.dream();
    const paused = pauseCleanReview(f);
    const pending = f.engine.review(reviewRequest(job), { actor: f.actor });
    const rejected = assert.rejects(pending, { code: 'STALE_REVIEW' });
    await paused.ready;
    const path = sourceKind === 'target' ? join(f.config.memoryRoot, 'long-term.md')
      : sourceKind === 'evidence' ? f.daily
        : sourceKind === 'uncited persona' ? f.config.personaPath : join(f.config.memoryRoot, 'journal.md');
    if (sourceKind === 'version-only') {
      const read = f.files.read;
      f.files.read = async (...args) => {
        const value = await read(...args);
        return args[0] === path ? { ...value, version: `new-version:${value.version}` } : value;
      };
    } else {
      const source = await f.files.read(path);
      await f.files.write(path, `${source.content}External correction during isolated review.\n`, source.version);
    }
    f.writes.length = 0;
    paused.release();
    await rejected;
    assert.deepEqual(f.writes, []);
    assert.deepEqual((await f.store.loadJob(job.jobId)).reviews, []);
    assert.deepEqual(await f.store.listTransactions(), []);
    assert.equal(f.calls.maintain, 0);
    if (sourceKind !== 'target') await assertNoApproval(f, job.jobId);
  });
}

for (const mutation of ['veto', 'defer', 'proposal', 'sibling proposal', 'snapshot', 'state']) {
  test(`concurrent ${mutation} cannot be overwritten by an in-flight isolated acceptance`, async t => {
    const f = await fixture(t);
    const job = await f.engine.dream();
    const paused = pauseCleanReview(f);
    const pending = f.engine.review(reviewRequest(job), { actor: f.actor });
    const rejected = assert.rejects(pending, { code: 'STALE_REVIEW' });
    await paused.ready;
    if (mutation === 'veto' || mutation === 'defer') {
      await f.engine.review(reviewRequest(job, 0, { decision: mutation === 'veto' ? 'reject' : 'defer', reason: 'Concurrent human-side veto.' }), { actor: f.actor });
    } else {
      await f.store.updateJob(job.jobId, current => {
        if (mutation === 'state') current.state = 'prepared';
        else if (mutation === 'snapshot') {
          current.snapshot.sources.find(source => source.role === 'persona').content += 'Updated authoritative snapshot.';
          // Keep the competing snapshot valid: the race, not a stale provenance hash,
          // must invalidate the review that is already in flight.
          current.snapshot = annotateSnapshot(current.snapshot, []);
        }
        else current.proposals[mutation === 'sibling proposal' ? 1 : 0].after += 'Changed proposal while reviewer was working.\n';
        return current;
      });
    }
    const changed = await f.store.loadJob(job.jobId);
    f.writes.length = 0;
    paused.release();
    await rejected;
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await f.store.loadJob(job.jobId), changed);
    await assertNoApproval(f, job.jobId);
  });
}

test('a duplicate isolated review does not dispatch a second model call', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const paused = pauseCleanReview(f);
  const pending = f.engine.review(reviewRequest(job), { actor: f.actor });
  await paused.ready;
  await assert.rejects(f.engine.review(reviewRequest(job), { actor: f.actor }), /already running/);
  assert.equal(f.calls.cleanReview.length, 1);
  paused.release();
  assert.equal((await pending).decision, 'accept');
  assert.equal((await f.store.loadJob(job.jobId)).reviews.length, 1);
});

for (const origin of ['main veto', 'isolated rejection']) test(`${origin} cannot be rerolled, including through a defer detour`, async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  f.setCleanReview(async (snapshot, proposal) => ({ decision: 'reject', reason: 'Synthetic evidence contradicts the edit.', authority: syntheticCleanAuthority(snapshot, proposal) }));
  await f.engine.review(reviewRequest(job, 0, { decision: origin === 'main veto' ? 'reject' : 'review' }), { actor: f.actor });
  const modelCalls = f.calls.cleanReview.length;
  f.setCleanReview(f.acceptCleanReview);
  f.writes.length = 0;
  await assert.rejects(f.engine.review(reviewRequest(job), { actor: f.actor }), /reject|reroll/i);
  assert.deepEqual(f.writes, []);
  // A main-chat defer must not erase the durable rejection and permit another roll.
  try { await f.engine.review(reviewRequest(job, 0, { decision: 'defer' }), { actor: f.actor }); }
  catch (error) { assert.match(error.message, /reject|reroll/i); }
  f.writes.length = 0;
  await assert.rejects(f.engine.review(reviewRequest(job), { actor: f.actor }), /reject|reroll/i);
  assert.deepEqual(f.writes, []);
  assert.equal(f.calls.cleanReview.length, modelCalls);
  await assertNoApproval(f, job.jobId);
});

for (const failure of ['provider error', 'timeout', 'invalid decision', 'missing authority', 'wrong digest']) {
  test(`isolated reviewer ${failure} leaves job, reviews and memory untouched`, async t => {
    const f = await fixture(t);
    const job = await f.engine.dream();
    f.setCleanReview(async (snapshot, proposal) => {
      if (failure === 'provider error') throw new Error('Synthetic provider unavailable');
      if (failure === 'timeout') throw Object.assign(new Error('Synthetic clean review timeout'), { code: 'CLEAN_REVIEW_TIMEOUT' });
      const result = await f.acceptCleanReview(snapshot, proposal);
      if (failure === 'invalid decision') return { ...result, decision: 'approve' };
      if (failure === 'missing authority') return { ...result, authority: undefined };
      return { ...result, authority: { ...result.authority, inputDigest: '0'.repeat(64) } };
    });
    f.writes.length = 0;
    await assert.rejects(f.engine.review(reviewRequest(job), { actor: f.actor }));
    assert.deepEqual(f.writes, []);
    assert.deepEqual(await f.store.loadJob(job.jobId), job);
    await assertNoApproval(f, job.jobId);
  });
}

test('cancellation after a non-cooperative reviewer returns cannot persist approval', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const controller = new AbortController();
  const paused = pauseCleanReview(f);
  const pending = f.engine.review(reviewRequest(job), { actor: f.actor, signal: controller.signal });
  const rejected = assert.rejects(pending, /Synthetic caller cancelled/);
  const { options } = await paused.ready;
  f.writes.length = 0;
  controller.abort(new Error('Synthetic caller cancelled'));
  assert.equal(options.signal.aborted, true);
  paused.release();
  await rejected;
  assert.deepEqual(f.writes, []);
  await assertNoApproval(f, job.jobId);
});

async function reviewRound(f, job, decisions) {
  for (const [index, decision] of decisions.entries()) {
    if (decision) await f.engine.review({ jobId: job.jobId, proposalId: job.proposals[index].proposalId,
      decision, reason: 'Checked the synthetic diary.' }, { actor: f.actor });
  }
  f.becomeIdle();
  await f.engine.flush();
  return f.store.loadJob(job.jobId);
}

for (const decision of ['compact', 'skip']) test(`agent compaction ${decision} waits for decision and idle, then requires reload`, async t => {
  const f = await fixture(t, { compactionMode: 'agent' });
  f.host.contextPressure = () => ({ totalTokens: 12000, contextWindow: 128000, baseline: 'estimated' });
  const job = await f.engine.dream();
  const pending = await reviewRound(f, job, ['review', 'reject']);
  assert.equal(pending.state, 'awaiting_compaction');
  assert.equal(f.calls.compact.length, 0);
  assert.equal(f.calls.reload.length, 0);
  assert.equal(pending.compactionDecisionDelivery.state, 'sent');
  const status = await f.engine.status({ jobId: job.jobId });
  assert.equal(status.contextPressure.totalTokens, 12000);
  const args = { jobId: job.jobId, transactionId: pending.transaction.transactionId, decision, reason: 'Judged current measured pressure and reload budget.' };
  await assert.rejects(f.engine.decideCompaction({ ...args, transactionId: 'old' }, { actor: f.actor }), /another transaction/);
  await assert.rejects(f.engine.decideCompaction(args, { actor: { agentId: 'other', sessionId: 'session' } }), /actor/);
  await f.engine.decideCompaction(args, { actor: f.actor });
  assert.equal(f.calls.compact.length, 0);
  assert.equal(f.calls.reload.length, 0);
  await assert.rejects(f.engine.decideCompaction({ ...args, decision: decision === 'skip' ? 'compact' : 'skip' }, { actor: f.actor }), /already recorded/);
  f.becomeIdle();
  await f.engine.flush();
  const reloaded = await f.store.loadJob(job.jobId);
  assert.equal(reloaded.state, 'awaiting_reload');
  assert.equal(reloaded.compaction.status, decision === 'skip' ? 'skipped' : 'completed');
  assert.equal(f.calls.compact.length, decision === 'skip' ? 0 : 1);
  assert.equal(f.calls.reload.length, 1);
  if (decision === 'skip') assert.match(f.calls.reload[0].text, /未执行压缩/);
  await f.engine.decideCompaction(args, { actor: f.actor });
  await f.engine.flush();
  assert.equal(f.calls.reload.length, 1);
  await acknowledge(f, job.jobId);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'completed');
  assert.equal(f.calls.maintain, 1);
});

test('agent decision survives restart without duplicate requests or bypass via submit', async t => {
  const f = await fixture(t, { compactionMode: 'agent' });
  const job = await f.engine.dream();
  await reviewRound(f, job, ['review', 'reject']);
  f.becomeIdle();
  const restarted = f.newEngine();
  await restarted.resume();
  await restarted.flush();
  restarted.submit({ jobId: job.jobId });
  await restarted.flush();
  assert.equal(f.calls.review.length, 2);
  assert.equal(f.calls.compact.length, 0);
  assert.equal((await restarted.status({ jobId: job.jobId })).contextPressure.unavailableReason, 'Host context measurement unavailable');
  const stored = await f.store.loadJob(job.jobId);
  await restarted.decideCompaction({ jobId: job.jobId, transactionId: stored.transaction.transactionId, decision: 'skip', reason: 'Explicit choice with unavailable measurement.' }, { actor: f.actor });
  await restarted.flush();
  await acknowledge(f, job.jobId, restarted);
});

test('a later accepted batch requires a new transaction decision instead of reusing skip', async t => {
  const f = await fixture(t, { compactionMode: 'agent' });
  const job = await f.engine.dream();
  const first = await reviewRound(f, job, ['review', 'defer']);
  const args = { jobId: job.jobId, transactionId: first.transaction.transactionId, decision: 'skip', reason: 'Enough room.' };
  await f.engine.decideCompaction(args, { actor: f.actor });
  f.becomeIdle();
  await f.engine.flush();
  await acknowledge(f, job.jobId);
  const second = await reviewRound(f, job, [undefined, 'review']);
  assert.equal(second.state, 'awaiting_compaction');
  assert.notEqual(second.transaction.transactionId, args.transactionId);
  assert.equal(second.compactionChoice, undefined);
  assert.equal(second.compaction, undefined);
  assert.equal(f.calls.reload.length, 1);
  await assert.rejects(f.engine.decideCompaction(args, { actor: f.actor }), /another transaction/);
  await f.engine.decideCompaction({ ...args, transactionId: second.transaction.transactionId }, { actor: f.actor });
  f.becomeIdle();
  await f.engine.flush();
  await acknowledge(f, job.jobId);
  assert.equal(f.calls.reload.length, 2);
  assert.equal(f.calls.maintain, 2);
});

test('decision delivery failure is explicitly retried without replaying committed writes', async t => {
  const f = await fixture(t, { compactionMode: 'agent' });
  const job = await f.engine.dream();
  const original = f.host.requestReview;
  f.host.requestReview = async () => { throw Object.assign(new Error('unavailable'), { code: 'UNAVAILABLE' }); };
  const pending = await reviewRound(f, job, ['review', 'reject']);
  assert.equal(pending.compactionDecisionDelivery.state, 'failed');
  assert.equal(f.calls.notify.length, 1);
  assert.match(f.calls.notify[0].text, /压缩决策请求/);
  assert.equal(f.calls.maintain, 1);
  f.host.requestReview = original;
  await f.engine.retry({ jobId: job.jobId });
  assert.equal((await f.store.loadJob(job.jobId)).compactionDecisionDelivery.state, 'sent');
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.compact.length, 0);
});

test('manual compaction gate survives submit, retry, resume and changed input without a second run', async t => {
  const f = await fixture(t, { compactionMode: 'manual', singleRun: true });
  const job = await f.engine.dream();
  const paused = await reviewRound(f, job, ['review', 'reject']);
  assert.equal(paused.state, 'awaiting_compaction');
  assert.equal(paused.compactionAttempts, 0);
  assert.equal(paused.compactionPauseDelivery.state, 'sent');
  assert.match(f.calls.notify[0].text, /已提交.*暂停/);
  assert.match(f.calls.notify[0].text, /auto/);
  const changed = await f.files.read(f.daily);
  await f.files.write(f.daily, `${changed.content}Additional synthetic event.`, changed.version);
  for (const engine of [f.engine, f.newEngine()]) {
    for (let index = 0; index < 3; index++) {
      engine.submit({ jobId: job.jobId });
      await engine.flush();
      await engine.retry({ jobId: job.jobId });
      await engine.flush();
      await engine.resume();
      await engine.flush();
      assert.equal((await engine.dream()).reason, 'single_run');
    }
  }
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_compaction');
  assert.equal(f.calls.compact.length, 0);
  assert.equal(f.calls.reload.length, 0);
  assert.equal(f.calls.notify.length, 1);
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.generate, 1);
  assert.equal((await f.store.listJobs()).length, 1);
  assert.equal((await f.store.listTransactions()).length, 1);
  assert.equal((await f.memory()).content.match(/experiment completed/g).length, 1);
});

async function acknowledge(f, jobId, engine = f.engine) {
  const job = await f.store.loadJob(jobId);
  const args = { jobId, transactionId: job.reload.transactionId, readSourceIds: job.reload.sources.map((source) => source.sourceId) };
  const result = await engine.ackReload(args, { actor: f.actor });
  await engine.flush();
  return { result, args };
}

test('generation uses the local 05:00–07:00 window and reuses unchanged materials', async (t) => {
  const f = await fixture(t);
  f.setTime(4, 59);
  assert.deepEqual(await f.engine.dream(), { skipped: true, reason: 'outside_rest_window' });
  assert.equal(f.calls.generate, 0);
  f.setTime(5);
  const job = await f.engine.dream();
  assert.equal(job.state, 'awaiting_review');
  f.setTime(6, 59);
  assert.deepEqual(await f.engine.dream(), { reused: true, jobId: job.jobId, state: 'awaiting_review' });
  f.setTime(7);
  assert.deepEqual(await f.engine.dream(), { skipped: true, reason: 'outside_rest_window' });
  assert.equal(f.calls.generate, 1);
  assert.equal(f.calls.review.length, 1);
  assert.equal(f.calls.notify.length, 0);
});

test('only the target agent can review; accepted items wait for idle and do not wait for deferred siblings', async (t) => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const accept = { jobId: job.jobId, proposalId: job.proposals[0].proposalId, decision: 'review', reason: 'Verified.' };
  await assert.rejects(f.engine.review(accept, { actor: { agentId: 'another', sessionId: 'another' } }), /actor/);
  await f.engine.review(accept, { actor: f.actor });
  await f.engine.review({ ...accept, proposalId: job.proposals[1].proposalId, decision: 'defer' }, { actor: f.actor });
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal(f.calls.maintain, 0);
  f.becomeIdle();
  await f.engine.flush();
  const pending = await f.store.loadJob(job.jobId);
  assert.equal(pending.state, 'awaiting_reload');
  assert.deepEqual(pending.appliedProposalIds, [job.proposals[0].proposalId]);
  assert.match((await f.memory()).content, /experiment completed/);
  assert.doesNotMatch((await f.memory()).content, /preference: concise/);
  assert.deepEqual(f.calls.order, ['maintain', 'compact', 'reload']);
  assert.equal(f.calls.notify.length, 0);
  await assert.rejects(f.engine.ackReload({ jobId: job.jobId, transactionId: pending.reload.transactionId, readSourceIds: [] }, { actor: f.actor }), /incomplete/);
  const { args } = await acknowledge(f, job.jobId);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_review');
  assert.equal(f.calls.notify.length, 1);
  await f.engine.ackReload(args, { actor: f.actor });
  assert.equal(f.calls.notify.length, 1);

  f.busy();
  await f.engine.review({ ...accept, proposalId: job.proposals[1].proposalId }, { actor: f.actor });
  f.becomeIdle();
  await f.engine.flush();
  await acknowledge(f, job.jobId);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'completed');
  assert.equal((await f.memory()).content.match(/experiment completed/g).length, 1);
  assert.equal((await f.memory()).content.match(/preference: concise/g).length, 1);
  assert.equal((await f.store.listTransactions()).length, 2);
  assert.equal(f.calls.notify.length, 2);
  assert.equal((await f.engine.dream()).reused, true);
  assert.equal(f.calls.generate, 1);
});

test('rejecting all proposals changes no memory, performs no compaction and sends no user report', async (t) => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const result = await reviewRound(f, job, ['reject', 'reject']);
  assert.equal(result.state, 'reviewed_no_changes');
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal(f.calls.maintain, 0);
  assert.equal(f.calls.compact.length, 0);
  assert.equal(f.calls.reload.length, 0);
  assert.equal(f.calls.notify.length, 0);
});

test('a deferred remainder can be rejected after a partial submission without failing the job', async (t) => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  await reviewRound(f, job, ['review', 'defer']);
  await acknowledge(f, job.jobId);
  f.busy();
  await f.engine.review({ jobId: job.jobId, proposalId: job.proposals[1].proposalId, decision: 'reject', reason: 'Not needed.' }, { actor: f.actor });
  f.becomeIdle();
  await f.engine.flush();
  const result = await f.store.loadJob(job.jobId);
  assert.equal(result.state, 'completed', result.error?.message);
  assert.equal(f.calls.compact.length, 1);
  assert.equal(f.calls.notify.length, 1);
});

test('a target or evidence edit after accept blocks the stale write', async (t) => {
  for (const kind of ['target', 'evidence']) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      const job = await f.engine.dream();
      await f.engine.review({ jobId: job.jobId, proposalId: job.proposals[0].proposalId, decision: 'review', reason: 'Verified.' }, { actor: f.actor });
      const path = kind === 'target' ? join(f.config.memoryRoot, 'long-term.md') : f.daily;
      const original = await f.files.read(path);
      await f.files.write(path, 'External synthetic correction.\n', original.version);
      f.becomeIdle();
      await f.engine.flush();
      const failed = await f.store.loadJob(job.jobId);
      assert.equal(failed.state, 'failed');
      assert.equal(failed.error.code, 'FILE_CONFLICT');
      assert.deepEqual(failed.appliedProposalIds, []);
      assert.equal((await f.files.read(path)).content, 'External synthetic correction.\n');
      assert.equal(f.calls.compact.length, 0);
      if (kind === 'evidence') assert.equal((await f.memory()).content, initialMemory);
    });
  }
});

test('busy compaction retries only compaction, never memory application; no-op is reported truthfully', async (t) => {
  const f = await fixture(t);
  f.compactions.push(Object.assign(new Error('Host busy'), { code: 'busy' }), null);
  const job = await f.engine.dream();
  const pending = await reviewRound(f, job, ['review', 'reject']);
  assert.equal(pending.state, 'awaiting_compaction');
  const submitted = (await f.memory()).content;
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.notify.length, 0);
  await f.engine.retry({ jobId: job.jobId });
  await f.engine.flush();
  assert.equal(f.calls.compact.length, 2);
  assert.equal(f.calls.maintain, 1);
  assert.equal((await f.memory()).content, submitted);
  assert.equal((await f.store.listTransactions()).length, 1);
  assert.equal(f.writes.filter((path) => path === 'memory/long-term.md').length, 1);
  await acknowledge(f, job.jobId);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'completed');
  assert.match(f.calls.notify[0].text, /无操作/);
});

test('a plugin-authored memory update does not generate another dream while compaction is busy', async (t) => {
  const f = await fixture(t);
  f.compactions.push(Object.assign(new Error('Host busy'), { code: 'busy' }));
  const job = await f.engine.dream();
  await reviewRound(f, job, ['review', 'reject']);
  const next = await f.engine.dream();
  assert.equal(f.calls.generate, 1, `Unexpected second job: ${next.jobId}`);
  assert.ok(next.reused || next.skipped);
});

test('restart resumes a confirmed application but pauses an uncertain compaction', async (t) => {
  for (const interrupted of ['applied', 'compacting']) {
    await t.test(interrupted, async (subtest) => {
      const f = await fixture(subtest);
      const job = await f.engine.dream();
      await reviewRound(f, job, ['review', 'reject']);
      await f.store.updateJob(job.jobId, (current) => {
        current.state = interrupted;
        delete current.compaction;
        delete current.reload;
        delete current.reloadDelivery;
        delete current.processedSnapshot;
        delete current.processedFingerprint;
        return current;
      });
      const previousWrites = f.writes.filter((path) => path === 'memory/long-term.md').length;
      const previousCompactions = f.calls.compact.length;
      const restarted = f.newEngine();
      await restarted.resume();
      await restarted.flush();
      const result = await f.store.loadJob(job.jobId);
      assert.equal(f.writes.filter((path) => path === 'memory/long-term.md').length, previousWrites);
      if (interrupted === 'applied') {
        assert.equal(result.state, 'awaiting_reload');
        assert.equal(f.calls.compact.length, previousCompactions + 1);
        await acknowledge(f, job.jobId, restarted);
        assert.equal((await f.store.loadJob(job.jobId)).state, 'completed');
      } else {
        assert.equal(result.state, 'failed');
        assert.equal(result.phase, 'compacting');
        assert.equal(f.calls.compact.length, previousCompactions);
        await assert.rejects(restarted.retry({ jobId: job.jobId }), /uncertain/);
        assert.equal(f.calls.notify.length, 1);
      }
    });
  }
});
