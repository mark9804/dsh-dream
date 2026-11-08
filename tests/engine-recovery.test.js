import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative } from 'node:path';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { createController } from '../dist/scheduler/controller.js';
import { validateConfig } from '../dist/config.js';
import { eligibleProposals, recordReview } from '../dist/review/index.js';
import { collectSnapshot, inputFingerprint } from '../dist/dream/materials.js';
import { proposalLineage } from '../dist/dream/lineage.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

async function fixture(t, overrides = {}) {
  const temporaryRoot = fileURLToPath(new URL('.tmp/', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'engine-recovery-'));
  const local = createLocalFiles(directory);
  const localPath = path => isAbsolute(path) ? relative(directory, path) : path;
  const files = { ...local };
  for (const method of ['read', 'stat', 'list', 'mkdir', 'remove']) files[method] = (path, ...args) => local[method](localPath(path), ...args);
  files.write = (path, ...args) => local.write(localPath(path), ...args);
  const config = validateConfig({ sessionId: 'session', memoryRoot: join(directory, 'memory'), stateRoot: join(directory, 'state'), ...overrides });
  const scope = { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: config.memoryRoot };
  const actor = { agentId: 'agent', sessionId: 'session' };
  await files.mkdir(join(config.memoryRoot, 'daily'));
  await files.mkdir(join(config.memoryRoot, 'ideas'));
  await files.write(join(config.memoryRoot, 'long-term.md'), 'Initial synthetic memory.\n', null);
  await files.write(join(config.memoryRoot, 'decisions.md'), 'Synthetic decisions.\n', null);
  await files.write(join(config.memoryRoot, 'journal.md'), 'Synthetic event. Another synthetic event.\n', null);
  let clock = new Date(2026, 9, 26, 5, 30);
  let sequence = 0;
  let lockDepth = 0;
  let idle;
  let release;
  let generationHook;
  const calls = { generate: 0, lock: 0, maintain: 0, compact: 0, review: [], reload: [], report: [], attention: [] };
  const failures = { review: [], reload: [], report: [] };
  const engines = [];
  const controllers = [];
  const id = () => `fixture-${++sequence}`;
  function busy() { if (!idle) idle = new Promise(resolve => { release = resolve; }); }
  function becomeIdle() { const done = release; idle = undefined; release = undefined; done?.(); }
  async function send(kind, text, receipt) {
    calls[kind].push({ text, ...receipt });
    if (failures[kind]?.length) throw failures[kind].shift();
    if (kind === 'review') busy();
  }
  const host = {
    async waitForIdle() { if (idle) await idle; },
    async maintain(operation) { calls.maintain++; return operation(); },
    async compact() { calls.compact++; return { compactionId: `compact-${calls.compact}` }; },
    requestReview: (text, receipt) => send('review', text, receipt),
    requestReload: (text, receipt) => send('reload', text, receipt),
    notify: (text, receipt) => send(text.startsWith('DSH-Dream 需要处理') ? 'attention' : 'report', text, receipt),
  };
  const store = createStore(files, { root: config.stateRoot, lockKey: scope.memoryRootId, now: () => clock.toISOString() });
  function newEngine() {
    const controller = new AbortController();
    controllers.push(controller);
    const engine = createEngine({ config, scope, files, store, host, signal: controller.signal, now: () => new Date(clock), id,
      // Explicit synthetic reviewer for offline fixtures, never a production fallback.
      cleanReview: async (snapshot, proposal) => ({ decision: 'accept', reason: 'Verified synthetic evidence.', authority: syntheticCleanAuthority(snapshot, proposal) }),
      generationLock: async operation => {
        calls.lock++;
        assert.equal(++lockDepth, 1, 'Generation lock must not be nested or bypassed');
        try { return await operation(); } finally { lockDepth--; }
      },
      generate: async (snapshot, jobId, options) => {
        assert.equal(lockDepth, 1);
        calls.generate++;
        await generationHook?.(options);
        return { dream: `Synthetic dream ${calls.generate}.`, proposals: [
          { schemaVersion: 1, proposalId: `${jobId}-one`, jobId, kind: 'fact', text: 'Synthetic event.', reason: 'Journal evidence.', evidence: [{ sourceId: 'journal.md', quote: 'Synthetic event.' }], targetId: 'long-term.md', operation: 'append', before: '', after: 'Synthetic event recorded.\n' },
          { schemaVersion: 1, proposalId: `${jobId}-two`, jobId, kind: 'preference', text: 'Another synthetic event.', reason: 'Journal evidence.', evidence: [{ sourceId: 'journal.md', quote: 'Another synthetic event.' }], targetId: 'long-term.md', operation: 'append', before: '', after: 'Another synthetic event recorded.\n' },
        ] };
      },
    });
    engines.push(engine);
    return engine;
  }
  const engine = newEngine();
  t.after(async () => {
    becomeIdle();
    controllers.forEach(controller => controller.abort(new Error('Fixture cleanup')));
    await Promise.all(engines.map(instance => instance.flush().catch(() => {})));
    await rm(directory, { recursive: true, force: true });
  });
  async function persistReviews(jobId, decisions) {
    return store.updateJob(jobId, current => decisions.reduce((job, decision, index) => recordReview(job,
      { proposalId: job.proposals[index].proposalId, decision, reason: 'Verified synthetic evidence.' }, actor, {
        reviewId: id(), now: clock.toISOString(),
        ...(decision === 'accept' ? { authority: syntheticCleanAuthority(job.snapshot, job.proposals[index]) } : {}),
      }), current));
  }
  async function submit(jobId, decisions = ['accept', 'reject']) {
    await persistReviews(jobId, decisions);
    engine.submit({ jobId });
    becomeIdle();
    await engine.flush();
    return store.loadJob(jobId);
  }
  async function acknowledge(jobId, target = engine) {
    const job = await store.loadJob(jobId);
    return target.ackReload({ jobId, transactionId: job.reload.transactionId, readSourceIds: job.reload.sources.map(source => source.sourceId) }, { actor });
  }
  return { engine, newEngine, store, files, config, scope, actor, calls, failures, persistReviews, submit, acknowledge, becomeIdle,
    setTime: (...parts) => { clock = new Date(...parts); },
    setGeneration: hook => { generationHook = hook; },
  };
}

async function earlyJob(f, state) {
  const date = new Date(2026, 9, 26, 5, 30);
  const snapshot = await collectSnapshot(f.files, f.config, f.scope, { now: date, snapshotId: 'early-snapshot' });
  const job = { schemaVersion: 1, jobId: `interrupted-${state}`, scope: f.scope, snapshot,
    state, proposals: [], reviews: [], appliedProposalIds: [], createdAt: date.toISOString(),
    updatedAt: date.toISOString(), inputFingerprint: inputFingerprint(snapshot) };
  await f.store.saveJob(job);
  return job;
}

test('manual recovery from applied and failed post-commit states never compacts or repeats pause delivery', async t => {
  for (const state of ['applied', 'awaiting_compaction', 'failed', 'cancelled']) await t.test(state, async t => {
    const f = await fixture(t, { compactionMode: 'manual', singleRun: true });
    const job = await f.engine.dream();
    await f.submit(job.jobId);
    await f.store.updateJob(job.jobId, current => ({ ...current, state,
      ...(state === 'failed' || state === 'cancelled' ? { phase: 'awaiting_compaction', checkpoint: { state: 'awaiting_compaction' } } : {}),
      compactionPauseDelivery: undefined }));
    const resumed = f.newEngine();
    if (state === 'failed' || state === 'cancelled') await resumed.retry({ jobId: job.jobId });
    else await resumed.resume();
    await resumed.flush();
    assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_compaction');
    const notifications = f.calls.report.length;
    await resumed.retry({ jobId: job.jobId });
    await resumed.flush();
    await resumed.resume();
    await resumed.flush();
    assert.equal(f.calls.report.length, notifications);
    assert.equal(f.calls.compact, 0);
    assert.equal(f.calls.reload.length, 0);
    assert.equal(f.calls.maintain, 1);
  });
});

test('manual pause failed or interrupted notification is not automatically redelivered', async t => {
  for (const state of ['failed', 'queued', 'uncertain']) await t.test(state, async t => {
    const f = await fixture(t, { compactionMode: 'manual' });
    const job = await f.engine.dream();
    await f.submit(job.jobId);
    await f.store.updateJob(job.jobId, current => ({ ...current,
      compactionPauseDelivery: { ...current.compactionPauseDelivery, state } }));
    const resumed = f.newEngine();
    await resumed.resume();
    await resumed.flush();
    await resumed.retry({ jobId: job.jobId });
    await resumed.flush();
    assert.equal(f.calls.report.length, 1);
    assert.equal(f.calls.compact, 0);
    assert.equal(f.calls.reload.length, 0);
  });
});

test('singleRun preserves early recovery but terminal jobs prevent another generation even after input changes', async t => {
  for (const state of ['queued', 'collecting']) await t.test(state, async t => {
    const f = await fixture(t, { singleRun: true });
    const job = await earlyJob(f, state);
    assert.equal((await f.engine.dream()).jobId, job.jobId);
    await f.submit(job.jobId, ['reject', 'reject']);
    const path = join(f.config.memoryRoot, 'journal.md');
    const before = await f.files.read(path);
    await f.files.write(path, `${before.content}New synthetic material.`, before.version);
    assert.equal((await f.newEngine().dream()).reason, 'single_run');
    assert.equal(f.calls.generate, 1);
    assert.equal((await f.store.listJobs()).length, 1);
  });
});

test('manual scheduler stops requeueing a persisted pause while auto continues polling', async () => {
  for (const compactionMode of ['manual', 'auto']) {
    let submits = 0;
    const engine = {
      async resume() {}, async dream() {},
      async status() { return { jobs: [{ jobId: 'paused', state: 'awaiting_compaction',
        deliveries: { compactionPauseDelivery: { state: 'sent' } } }] }; },
      submit() { submits++; },
    };
    const controller = createController({ config: { compactionMode, start: '05:00', end: '07:00', timeZone: 'local' },
      engine, host: { notify: assert.fail }, now: () => new Date(2026, 9, 26, 12), setTimer: () => 1, clearTimer() {} });
    controller.start();
    await controller.flush();
    for (let i = 0; i < 4; i++) await controller.tick();
    controller.stop();
    assert.equal(submits, compactionMode === 'manual' ? 0 : 5);
  }
});

test('queued and collecting interruptions resume in-window under the generation lock', async t => {
  for (const state of ['queued', 'collecting']) await t.test(state, async t => {
    const f = await fixture(t);
    const job = await earlyJob(f, state);
    const engine = f.newEngine();
    await engine.resume();
    await engine.flush();
    assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_review');
    assert.equal(f.calls.generate, 1);
    assert.equal(f.calls.lock, 1);
    assert.equal((await f.store.listJobs()).length, 1);
  });
});

test('early interruption waits in daytime and reuses its identity with freshly changed materials', async t => {
  const f = await fixture(t);
  const job = await earlyJob(f, 'collecting');
  f.setTime(2026, 9, 26, 12);
  const engine = f.newEngine();
  await engine.resume();
  assert.deepEqual(await engine.retry({ jobId: job.jobId }), { jobId: job.jobId, waiting: 'rest_window' });
  assert.equal(f.calls.generate, 0);
  const path = join(f.config.memoryRoot, 'journal.md');
  const before = await f.files.read(path);
  await f.files.write(path, `${before.content}New synthetic material.`, before.version);
  f.setTime(2026, 9, 27, 5, 30);
  const resumed = await engine.dream();
  assert.equal(resumed.jobId, job.jobId);
  assert.notEqual(resumed.inputFingerprint, job.inputFingerprint);
  assert.equal((await f.store.listJobs()).length, 1);
});

test('an unwritten conflict reopens review without retaining old approval authority', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  await f.persistReviews(job.jobId, ['accept', 'reject']);
  const path = join(f.config.memoryRoot, 'long-term.md');
  const before = await f.files.read(path);
  await f.files.write(path, `${before.content}External synthetic edit.`, before.version);
  f.engine.submit({ jobId: job.jobId });
  f.becomeIdle();
  await f.engine.flush();
  assert.equal((await f.store.loadJob(job.jobId)).error.code, 'FILE_CONFLICT');
  const result = await f.engine.retry({ jobId: job.jobId });
  assert.equal(result.requiresReview, true);
  const reopened = await f.store.loadJob(job.jobId);
  assert.equal(reopened.state, 'awaiting_review');
  assert.equal(eligibleProposals(reopened).length, 0);
  assert.equal((await f.engine.status({ jobId: job.jobId })).proposals[0].approvalCurrent, false);
  assert.equal(f.calls.compact, 0);
  await f.engine.review({ jobId: job.jobId, proposalId: job.proposals[0].proposalId,
    decision: 'reject', reason: 'Do not apply this obsolete update.' }, { actor: f.actor });
  f.becomeIdle();
  await f.engine.flush();
  assert.equal((await f.store.loadJob(job.jobId)).state, 'reviewed_no_changes');
  assert.equal((await f.files.read(path)).content, `${before.content}External synthetic edit.`);
});

test('a cancelled prepared manifest can reopen review idempotently after a crash', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  await f.persistReviews(job.jobId, ['accept', 'reject']);
  const commit = f.store.commit;
  f.store.commit = (changes, resolve) => commit(changes, resolve, { afterStep({ phase }) {
    if (phase === 'prepared') throw Object.assign(new Error('Simulated pre-write conflict'), { code: 'FILE_CONFLICT' });
  } });
  f.engine.submit({ jobId: job.jobId }); f.becomeIdle(); await f.engine.flush();
  const failed = await f.store.loadJob(job.jobId);
  await f.store.cancelUnwritten(failed.transaction.transactionId, { reason: 'Interrupted conflict resolution' });
  await f.engine.retry({ jobId: job.jobId });
  const reopened = await f.store.loadJob(job.jobId);
  assert.equal(reopened.state, 'awaiting_review');
  assert.equal(eligibleProposals(reopened).length, 0);
  assert.equal((await f.store.listTransactions())[0].status, 'cancelled');
  // Only a fresh isolated review may replace invalidated acceptance authority.
  const previous = reopened.reviews.find(r => r.decision === 'accept');
  await f.engine.review({ jobId: job.jobId, proposalId: previous.proposalId,
    decision: 'review', reason: previous.reason }, { actor: f.actor });
  assert.equal(eligibleProposals(await f.store.loadJob(job.jobId)).length, 1);
  f.store.commit = commit; f.becomeIdle(); await f.engine.flush();
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_reload');
});

test('possible partial writes stay closed and expose a manual reconciliation path', async t => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  await f.persistReviews(job.jobId, ['accept', 'reject']);
  const commit = f.store.commit;
  f.store.commit = (changes, resolve) => commit(changes, resolve, { afterStep({ phase }) {
    if (phase === 'written') throw Object.assign(new Error('Simulated conflict after a write'), { code: 'FILE_CONFLICT' });
  } });
  f.engine.submit({ jobId: job.jobId }); f.becomeIdle(); await f.engine.flush();
  const path = join(f.config.memoryRoot, 'long-term.md');
  const applied = await f.files.read(path);
  await assert.rejects(f.engine.retry({ jobId: job.jobId }), { code: 'TRANSACTION_NOT_CANCELLABLE' });
  assert.equal((await f.engine.status({ jobId: job.jobId })).recovery.action, 'inspect_partial_transaction');
  assert.equal((await f.files.read(path)).content, applied.content);
  f.store.commit = commit;
  // Once inspected, retry only replays the original recoverable manifest; no rollback.
  await f.engine.retry({ jobId: job.jobId }); await f.engine.flush();
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_reload');
  assert.equal((await f.files.read(path)).content, applied.content);
  assert.equal((await f.engine.status({ jobId: job.jobId })).recovery, undefined);
});

test('restart submits persisted accept decisions and finishes an all-rejected batch', async (t) => {
  for (const decisions of [['accept', 'reject'], ['reject', 'reject']]) {
    await t.test(decisions.join('/'), async subtest => {
      const f = await fixture(subtest);
      const job = await f.engine.dream();
      await f.persistReviews(job.jobId, decisions);
      const restarted = f.newEngine();
      await restarted.resume();
      f.becomeIdle();
      await restarted.flush();
      const recovered = await f.store.loadJob(job.jobId);
      assert.equal(recovered.state, decisions[0] === 'accept' ? 'awaiting_reload' : 'reviewed_no_changes');
      assert.equal(f.calls.maintain, decisions[0] === 'accept' ? 1 : 0);
      assert.equal(f.calls.review.length, 1);
    });
  }
});

test('a queued review after interruption is exposed as uncertain and only explicitly retried', async (t) => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  const firstId = job.reviewDelivery.messageId;
  await f.store.updateJob(job.jobId, current => ({ ...current, reviewDelivery: { ...current.reviewDelivery, state: 'queued' } }));
  const restarted = f.newEngine();
  await restarted.resume();
  assert.equal(f.calls.review.length, 1);
  const status = await restarted.status({ jobId: job.jobId });
  assert.equal(status.deliveries.reviewDelivery.state, 'uncertain');
  assert.equal(status.deliveries.reviewDelivery.requiresInspection, true);
  const retried = await restarted.retry({ jobId: job.jobId });
  assert.equal(retried.delivery.state, 'sent');
  assert.notEqual(retried.delivery.messageId, firstId);
  assert.equal(retried.delivery.history[0].messageId, firstId);
  assert.equal(retried.delivery.history[0].state, 'uncertain');
  await restarted.retry({ jobId: job.jobId });
  assert.equal(f.calls.review.length, 2);
});

test('explicit retry resends a failed review without generating another dream', async (t) => {
  const f = await fixture(t);
  f.failures.review.push(Object.assign(new Error('No inbox available'), { code: 'UNAVAILABLE' }));
  const job = await f.engine.dream();
  assert.equal(job.reviewDelivery.state, 'failed');
  const result = await f.engine.retry({ jobId: job.jobId });
  assert.equal(result.delivery.state, 'sent');
  assert.equal(result.delivery.history[0].state, 'failed');
  assert.equal(f.calls.generate, 1);
});

test('reload and final-report retries never repeat memory submission or compaction', async (t) => {
  const f = await fixture(t);
  f.failures.reload.push(Object.assign(new Error('No inbox available'), { code: 'UNAVAILABLE' }));
  const job = await f.engine.dream();
  const committed = await f.submit(job.jobId);
  assert.equal(committed.state, 'awaiting_reload');
  assert.equal(committed.reloadDelivery.state, 'failed');
  assert.equal((await f.engine.retry({ jobId: job.jobId })).delivery.state, 'sent');
  await f.engine.retry({ jobId: job.jobId });
  assert.equal(f.calls.reload.length, 2);
  f.failures.report.push(new Error('Connection lost after dispatch'));
  const acknowledged = await f.acknowledge(job.jobId);
  assert.equal(acknowledged.state, 'completed');
  assert.equal(acknowledged.report.state, 'uncertain');
  assert.equal((await f.acknowledge(job.jobId)).report.state, 'uncertain');
  assert.equal(f.calls.report.length, 1);
  const result = await f.engine.retry({ jobId: job.jobId });
  assert.equal(result.delivery.state, 'sent');
  assert.equal(result.delivery.history[0].messageId, acknowledged.report.messageId);
  await f.engine.retry({ jobId: job.jobId });
  assert.equal(f.calls.report.length, 2);
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.compact, 1);
});

test('a repeated acknowledged receipt can recover an explicitly failed final report', async (t) => {
  const f = await fixture(t);
  const job = await f.engine.dream();
  await f.submit(job.jobId);
  f.failures.report.push(Object.assign(new Error('Inbox unavailable'), { code: 'UNAVAILABLE' }));
  assert.equal((await f.acknowledge(job.jobId)).report.state, 'failed');
  assert.equal((await f.acknowledge(job.jobId)).report.state, 'sent');
  assert.equal(f.calls.maintain, 1);
  assert.equal(f.calls.compact, 1);
});

test('a window-ended cancellation with unchanged materials resumes in the next window', async (t) => {
  const f = await fixture(t);
  const window = new AbortController();
  f.setGeneration(({ signal }) => {
    f.setTime(2026, 9, 26, 7);
    window.abort(Object.assign(new Error('Window ended'), { code: 'REST_WINDOW_ENDED' }));
    signal.throwIfAborted();
  });
  await assert.rejects(f.engine.dream({ signal: window.signal }), /Window ended/);
  const [cancelled] = await f.store.listJobs();
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await f.engine.dream()).reason, 'outside_rest_window');
  f.setTime(2026, 9, 27, 5, 30);
  f.setGeneration(undefined);
  const resumed = await f.engine.dream({ signal: new AbortController().signal });
  assert.equal(resumed.jobId, cancelled.jobId);
  assert.equal(resumed.state, 'awaiting_review');
  assert.equal(f.calls.generate, 2);
  assert.equal((await f.store.listJobs()).length, 1);
});

test('ordinary generation failures are not automatically retried every window', async (t) => {
  const f = await fixture(t);
  f.setGeneration(() => { throw new Error('Provider unavailable'); });
  await assert.rejects(f.engine.dream(), /Provider unavailable/);
  const [failed] = await f.store.listJobs();
  f.setTime(2026, 9, 27, 5, 30);
  assert.deepEqual(await f.engine.dream(), { reused: true, jobId: failed.jobId, state: 'failed' });
  assert.equal(f.calls.generate, 1);
});

test('persisted generation results recover before or after dream append without regenerating', async (t) => {
  for (const appended of [false, true]) {
    await t.test(appended ? 'already appended' : 'not yet appended', async subtest => {
      const f = await fixture(subtest);
      const job = await f.engine.dream();
      const saved = await f.store.loadDreamResult(job.jobId);
      const originalDream = await f.files.read(job.dreamPath);
      if (!appended) await f.files.remove(job.dreamPath);
      await f.store.updateJob(job.jobId, current => ({ ...current, state: 'generating', proposals: [], reviews: [], reviewDelivery: undefined, dreamPath: undefined }));
      f.setTime(2026, 9, 27, 12);
      const restarted = f.newEngine();
      await restarted.resume();
      f.becomeIdle();
      await restarted.flush();
      const recovered = await f.store.loadJob(job.jobId);
      assert.equal(recovered.state, 'awaiting_review');
      // The durable generator result stays raw; recovery binds Host-owned lineage
      // without changing any generated proposal field.
      assert.deepEqual(recovered.proposals.map(({ lineage, ...proposal }) => proposal), saved.proposals);
      for (const proposal of recovered.proposals) {
        assert.deepEqual(proposal.lineage, proposalLineage(proposal, recovered.snapshot));
        assert.ok(proposal.lineage.rootIds.length > 0);
        assert.equal(proposal.lineage.independentEvents, 'unknown');
      }
      assert.equal(recovered.dreamPath, job.dreamPath);
      assert.equal((await f.files.read(job.dreamPath)).content, originalDream.content);
      assert.equal(f.calls.generate, 1);
      assert.equal((await f.files.list(join(f.config.stateRoot, 'dreams'))).filter(entry => entry.name.endsWith('.md')).length, 1);
    });
  }
});
