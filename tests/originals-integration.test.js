import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { applyProposal, validateSnapshot } from '../dist/domain/contracts.js';
import { transition } from '../dist/domain/state-machine.js';
import { attachOriginalSources, requireOriginalEvidence } from '../dist/dream/originals.js';
import { createEngine } from '../dist/engine.js';
import { CLEAN_REVIEW_POLICY } from '../dist/harness/clean-review.js';
import { recordReview, reviewMatches } from '../dist/review/index.js';
import { buildCleanReviewPayload, cleanReviewDigest, reviewPolicyVersion } from '../dist/review/isolation.js';
import { createStore } from '../dist/storage/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const now = '2026-10-26T05:30:00Z';
const memoryRoot = '/synthetic-originals/memory';
const stateRoot = '/synthetic-originals/state';
const scope = { scopeId: 'original-fixture', agentId: 'session', sessionId: 'session', memoryRootId: memoryRoot };
const quote = 'The synthetic experiment finished.';
const ref = { sessionId: 'session', seq: 7, blockIndex: 0, quote };
const bindings = [{ sourceId: 'journal.md', ref }];
const initialMemory = 'Existing synthetic memory.\n';
const initialDecisions = 'Existing synthetic decisions.\n';

function verified(overrides = {}) {
  return { schemaVersion: 1, ref: structuredClone(ref), status: 'verified',
    canonical: { sessionId: ref.sessionId, seq: ref.seq, messageId: 'synthetic-message', role: 'assistant', sourceKind: 'model', eventHash: 'synthetic-event-v1' },
    independentEvents: 'unknown', ...overrides };
}

function unverified(status = 'unavailable') {
  return { schemaVersion: 1, ref: structuredClone(ref), status, reason: 'Synthetic source access revoked or content missing.', independentEvents: 'unknown' };
}

function rawSnapshot() {
  return { schemaVersion: 1, snapshotId: 'snapshot', scope: structuredClone(scope), capturedAt: now,
    sources: [
      { sourceId: 'journal.md', path: 'journal.md', role: 'journal', content: `${quote} Unrelated synthetic observation.`, writable: false },
      { sourceId: 'long-term.md', path: 'long-term.md', role: 'longTerm', content: initialMemory, writable: true },
      { sourceId: 'decisions.md', path: 'decisions.md', role: 'decisions', content: initialDecisions, writable: true },
    ].map(source => ({ ...source, version: `version:${source.sourceId}`, sensitivity: 'private', protectedText: [] })) };
}

test('partial citation overlap cannot bypass an unavailable original link', () => {
  const snapshot = rawSnapshot();
  snapshot.sources[0].content = 'alpha beta gamma. Unrelated note.';
  snapshot.sources[0].originals = [{ ...unverified(), ref: { ...ref, quote: 'alpha beta' } }];
  assert.throws(() => requireOriginalEvidence(snapshot, [{ sourceId: 'journal.md', quote: 'beta gamma' }]), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
  assert.doesNotThrow(() => requireOriginalEvidence(snapshot, [{ sourceId: 'journal.md', quote: 'Unrelated note.' }]));
});

function proposal(jobId = 'job', targetId = 'long-term.md') {
  return { schemaVersion: 1, proposalId: `${jobId}:${targetId}`, jobId, kind: 'fact', text: quote,
    reason: 'The synthetic journal records this experiment.', evidence: [{ sourceId: 'journal.md', quote }],
    targetId, operation: 'append', before: '', after: 'Synthetic experiment completed.\n' };
}

function pendingJob(snapshot, proposals = [proposal()]) {
  return { schemaVersion: 1, jobId: 'job', scope: structuredClone(scope), snapshot, state: 'awaiting_review', proposals,
    reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now };
}

function accept(job, item = job.proposals[0]) {
  return recordReview(job, { proposalId: item.proposalId, decision: 'accept', reason: 'Synthetic independent check.' }, scope,
    { reviewId: `review:${item.proposalId}`, now, authority: syntheticCleanAuthority(job.snapshot, item) });
}

// Fully synthetic injected filesystem: these tests never read Host sessions or disk memory.
function memoryFiles() {
  const entries = new Map();
  const directories = new Set(['/']);
  const writes = [];
  let version = 0;
  let queue = Promise.resolve();
  const files = {
    async mkdir(path) {
      for (let current = path; !directories.has(current); current = dirname(current)) directories.add(current);
    },
    async stat(path) {
      const entry = entries.get(path);
      return entry ? { type: 'file', size: Buffer.byteLength(entry.content) } : directories.has(path) ? { type: 'directory' } : null;
    },
    async read(path, options = {}) {
      const entry = entries.get(path);
      if (entry && Buffer.byteLength(entry.content) > (options.maxBytes ?? Infinity)) throw Object.assign(new Error('Synthetic byte bound'), { code: 'FS_TOO_LARGE' });
      return entry ? structuredClone(entry) : null;
    },
    async write(path, content, expected) {
      const current = entries.get(path);
      if ((current?.version ?? null) !== expected) throw Object.assign(new Error('Synthetic version conflict'), { code: 'FILE_CONFLICT' });
      await files.mkdir(dirname(path));
      const next = `v${++version}`;
      entries.set(path, { content, version: next });
      writes.push(path);
      return next;
    },
    async list(path) {
      return [...directories].filter(entry => entry !== path && dirname(entry) === path).map(entry => ({ name: entry.slice(path.length + 1), isDirectory: true }))
        .concat([...entries.keys()].filter(entry => dirname(entry) === path).map(entry => ({ name: entry.slice(path.length + 1), isDirectory: false })));
    },
    withLock(_key, operation) {
      const result = queue.then(operation);
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
  return { files, entries, writes };
}

async function storageFixture() {
  const f = memoryFiles();
  const snapshot = rawSnapshot();
  for (const source of snapshot.sources) source.version = await f.files.write(join(memoryRoot, source.path), source.content, null);
  const state = { receipt: verified(), calls: [] };
  const verifyOriginal = async (requested, options) => {
    state.calls.push({ ref: structuredClone(requested), signal: options?.signal });
    assert.deepEqual(requested, ref);
    return structuredClone(state.receipt);
  };
  const bound = await attachOriginalSources(snapshot, bindings, verifyOriginal);
  const options = { root: stateRoot, lockKey: memoryRoot, now: () => now };
  const store = createStore(f.files, { ...options, verifyOriginal });
  f.writes.length = 0;
  return { ...f, state, verifyOriginal, options, store, snapshot: bound,
    job: pendingJob(bound, [proposal('job', 'long-term.md'), proposal('job', 'decisions.md')]),
    resolveTarget: sourceId => join(memoryRoot, sourceId),
    memory: () => f.files.read(join(memoryRoot, 'long-term.md')),
    decisions: () => f.files.read(join(memoryRoot, 'decisions.md')) };
}

async function prepare(f) {
  let job = f.job;
  for (const item of job.proposals) job = accept(job, item);
  job = transition(transition(job, 'prepared', { now }), 'applying', { now });
  await f.store.saveJob(job);
  const changeSet = { schemaVersion: 1, transactionId: 'transaction', jobId: job.jobId,
    proposalIds: job.proposals.map(item => item.proposalId), reviewIds: job.reviews.map(review => review.reviewId), status: 'prepared',
    changes: job.proposals.map(item => {
      const source = job.snapshot.sources.find(source => source.sourceId === item.targetId);
      return { targetId: source.sourceId, before: source.content, after: applyProposal(source.content, item), version: source.version };
    }) };
  f.writes.length = 0;
  return changeSet;
}

async function engineFixture(t, { configured = true, unavailableVerifier = false } = {}) {
  const f = await storageFixture();
  await f.files.mkdir(join(memoryRoot, 'daily'));
  await f.files.mkdir(join(memoryRoot, 'ideas'));
  const config = validateConfig({ sessionId: scope.sessionId, memoryRoot, stateRoot, timeZone: 'UTC', compactionMode: 'manual',
    originalSources: configured ? bindings : [] });
  const calls = { generate: [], review: [], compact: 0, maintain: 0, notify: [] };
  const controller = new AbortController();
  let release;
  const idle = new Promise(resolve => { release = resolve; });
  let reviewer = async (snapshot, item) => ({ decision: 'accept', reason: 'Synthetic isolated check.', authority: syntheticCleanAuthority(snapshot, item) });
  let sequence = 0;
  const engine = createEngine({ config, scope, files: f.files, store: f.store, signal: controller.signal,
    verifyOriginal: unavailableVerifier ? undefined : f.verifyOriginal,
    now: () => new Date(now), id: () => `engine-${++sequence}`,
    async generate(snapshot, jobId) { calls.generate.push(structuredClone(snapshot)); return { dream: 'Synthetic dream, not evidence.', proposals: [proposal(jobId)] }; },
    async cleanReview(...args) { calls.review.push(structuredClone(args.slice(0, 2))); return reviewer(...args); },
    host: { async waitForIdle() { await idle; }, async maintain(work) { calls.maintain++; return work(controller.signal); },
      async requestReview() {}, async requestReload() { assert.fail('manual mode must not reload'); },
      async compact() { calls.compact++; assert.fail('manual mode must not compact'); }, async notify(text) { calls.notify.push(text); } },
  });
  t.after(async () => { release(); await engine.flush(); controller.abort(new Error('Synthetic fixture stopped')); });
  return { ...f, engine, calls, controller, release,
    setReviewer(value) { reviewer = value; },
    review(job, options = {}) { return engine.review({ jobId: job.jobId, proposalId: job.proposals[0].proposalId, decision: 'review', reason: 'Main chat reason is not original evidence.' }, { actor: scope, ...options }); } };
}

test('binding refresh replaces stale receipts without promoting assistant/model text to user authority', async () => {
  const raw = rawSnapshot();
  raw.sources[0].originals = [verified({ canonical: { ...verified().canonical, role: 'user', sourceKind: 'forged-user' } })];
  const original = structuredClone(raw);
  const controller = new AbortController();
  const snapshot = await attachOriginalSources(raw, bindings, async (requested, options) => {
    assert.notEqual(requested, ref);
    assert.deepEqual(requested, ref);
    assert.equal(options.signal, controller.signal);
    return verified();
  }, controller.signal);
  validateSnapshot(snapshot);
  assert.deepEqual(raw, original);
  const receipt = snapshot.sources[0].originals[0];
  assert.equal(receipt.canonical.role, 'assistant');
  assert.equal(receipt.canonical.sourceKind, 'model');
  assert.equal(receipt.independentEvents, 'unknown');
  const payload = buildCleanReviewPayload(snapshot, proposal());
  assert.equal(payload.policyVersion, 3);
  assert.deepEqual(payload.sources.find(source => source.sourceId === 'journal.md').originals, [receipt]);
  assert.match(CLEAN_REVIEW_POLICY, /assistant text is a model claim/);
  assert.match(CLEAN_REVIEW_POLICY, /neither is a user instruction/);
  payload.sources.find(source => source.sourceId === 'journal.md').originals[0].canonical.role = 'user';
  assert.equal(receipt.canonical.role, 'assistant');
});

test('unconfigured sources retain file-only compatibility and discard unconfigured receipt claims', async () => {
  const raw = rawSnapshot();
  raw.sources[0].originals = [verified()];
  const snapshot = await attachOriginalSources(raw, [], () => assert.fail('No configured original should be read'));
  assert.ok(snapshot.sources.every(source => !Object.hasOwn(source, 'originals')));
  assert.equal(reviewPolicyVersion(snapshot, proposal()), 1);
  assert.equal(reviewMatches(accept(pendingJob(snapshot)), accept(pendingJob(snapshot)).reviews[0]), true);
  assert.doesNotThrow(() => requireOriginalEvidence(snapshot, proposal().evidence));
});

for (const status of ['invalid', 'unavailable']) test(`${status} original receipts cannot approve covered citations but do not taint unrelated text`, async () => {
  const snapshot = await attachOriginalSources(rawSnapshot(), bindings, async () => unverified(status));
  for (const cited of [quote, 'synthetic experiment', `${quote} Unrelated synthetic observation.`]) {
    assert.throws(() => requireOriginalEvidence(snapshot, [{ sourceId: 'journal.md', quote: cited }]), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
  }
  assert.doesNotThrow(() => requireOriginalEvidence(snapshot, [{ sourceId: 'journal.md', quote: 'Unrelated synthetic observation.' }]));
  assert.throws(() => accept(pendingJob(snapshot)), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
});

test('a removed linked quote is invalid without consulting the verifier, and a missing verifier stays unavailable', async () => {
  const raw = rawSnapshot();
  raw.sources[0].content = 'Only an unrelated synthetic observation remains.';
  const invalid = await attachOriginalSources(raw, bindings, () => assert.fail('Missing quote is not a valid lookup request'));
  assert.equal(invalid.sources[0].originals[0].status, 'invalid');
  assert.equal(invalid.sources[0].originals[0].canonical, undefined);
  const unavailable = await attachOriginalSources(rawSnapshot(), bindings);
  assert.equal(unavailable.sources[0].originals[0].status, 'unavailable');
  assert.throws(() => accept(pendingJob(unavailable)), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
});

test('missing bindings and malformed verified identities fail closed rather than acquiring authority', async () => {
  const raw = rawSnapshot();
  const uncollected = await attachOriginalSources(raw, [{ ...bindings[0], sourceId: 'missing.md' }], () => assert.fail('Uncollected source must not be queried'));
  assert.deepEqual(uncollected.originalCoverage, { uncollectedSourceIds: ['missing.md'] });
  assert.equal(uncollected.sources.some(s => s.originals), false);
  for (const receipt of [verified({ ref: { ...ref, seq: 8 } }), verified({ canonical: undefined })]) {
    await assert.rejects(attachOriginalSources(raw, bindings, async () => receipt), TypeError);
  }
  for (const receipt of [
    verified({ canonical: { ...verified().canonical, role: 'system' } }),
    verified({ canonical: { ...verified().canonical, seq: 8 } }),
    verified({ independentEvents: 1 }), verified({ schemaVersion: 2 }),
  ]) {
    const snapshot = await attachOriginalSources(raw, bindings, async () => receipt);
    assert.throws(() => validateSnapshot(snapshot), TypeError);
  }
  assert.ok(raw.sources.every(source => source.originals === undefined));
});

test('original attachment cancellation before and during verification exposes no partial receipt snapshot', async () => {
  const raw = rawSnapshot();
  const before = structuredClone(raw);
  const early = AbortSignal.abort(new Error('Cancelled before original verification'));
  await assert.rejects(attachOriginalSources(raw, bindings, () => assert.fail('Pre-cancelled verification must not run'), early), /Cancelled before/);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(attachOriginalSources(raw, bindings, async (_ref, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error('Cancelled during original verification'));
    return verified();
  }, controller.signal), /Cancelled during/);
  assert.equal(calls, 1);
  assert.deepEqual(raw, before);
});

test('v3 approval binds every original receipt field and cannot fall back to a v2 digest', async () => {
  const snapshot = await attachOriginalSources(rawSnapshot(), bindings, async () => verified());
  const item = proposal();
  const job = accept(pendingJob(snapshot));
  const review = job.reviews[0];
  assert.equal(review.authority.policyVersion, 3);
  assert.equal(reviewMatches(job, review), true);
  assert.notEqual(cleanReviewDigest(snapshot, item), cleanReviewDigest(snapshot, item, 2));
  for (const mutate of [
    receipt => { receipt.canonical.eventHash = 'changed-event'; },
    receipt => { receipt.canonical.role = 'user'; },
    receipt => { receipt.canonical.sourceKind = 'notification'; },
    receipt => { receipt.canonical.messageId = 'another-message'; },
    receipt => { receipt.ref.blockIndex = 1; },
    receipt => { receipt.chain = [{ sessionId: 'session', seq: 6 }]; },
    receipt => { receipt.status = 'unavailable'; },
  ]) {
    const changed = structuredClone(job);
    mutate(changed.snapshot.sources[0].originals[0]);
    assert.notEqual(cleanReviewDigest(changed.snapshot, item), review.authority.inputDigest);
    assert.equal(reviewMatches(changed, review), false);
  }
  assert.throws(() => recordReview(pendingJob(snapshot), { proposalId: item.proposalId, decision: 'accept', reason: 'Old authority cannot grant v3 permission.' }, scope,
    { reviewId: 'old-policy', now, authority: syntheticCleanAuthority(snapshot, item, { policyVersion: 2, inputDigest: cleanReviewDigest(snapshot, item, 2) }) }), { code: 'CLEAN_REVIEW_REQUIRED' });
});

test('direct storage commit cannot bypass a required original verifier', async () => {
  const f = await storageFixture();
  const changeSet = await prepare(f);
  const bypass = createStore(f.files, f.options);
  await assert.rejects(bypass.commit(changeSet, f.resolveTarget), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.store.listTransactions(), []);
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal((await f.decisions()).content, initialDecisions);
});

test('unchanged original receipts permit reviewed commit and still recheck at the manifest boundary', async () => {
  const f = await storageFixture();
  const changeSet = await prepare(f);
  f.state.calls.length = 0;
  assert.equal((await f.store.commit(changeSet, f.resolveTarget)).status, 'applied');
  assert.ok(f.state.calls.length >= 2, 'New commit and manifest application both verify original receipts');
  assert.equal((await f.memory()).content, initialMemory + proposal().after);
  assert.equal((await f.decisions()).content, initialDecisions + proposal().after);
});

for (const change of ['edited', 'revoked', 'invalid']) test(`direct commit refuses ${change} original source after clean review without writing a manifest or memory`, async () => {
  const f = await storageFixture();
  const changeSet = await prepare(f);
  f.state.receipt = change === 'edited' ? verified({ canonical: { ...verified().canonical, eventHash: 'synthetic-event-v2' } }) : unverified(change === 'revoked' ? 'unavailable' : 'invalid');
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'ORIGINAL_SOURCE_CONFLICT' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(await f.store.listTransactions(), []);
  assert.equal((await f.memory()).content, initialMemory);
});

test('a prepared transaction rechecks originals on recovery and cannot bypass them with another store instance', async () => {
  const f = await storageFixture();
  const changeSet = await prepare(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, { afterStep({ phase }) {
    if (phase === 'prepared') throw new Error('Synthetic interruption before target writes');
  } }), /Synthetic interruption/);
  f.writes.length = 0;
  await assert.rejects(createStore(f.files, f.options).recover('transaction'), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
  f.state.receipt = unverified();
  await assert.rejects(f.store.recover('transaction'), { code: 'ORIGINAL_SOURCE_CONFLICT' });
  assert.deepEqual(f.writes, []);
  assert.equal((await f.memory()).content, initialMemory);
  assert.equal((await f.decisions()).content, initialDecisions);
  f.state.receipt = verified();
  assert.equal((await f.store.recover('transaction')).status, 'applied');
});

test('revoked original access during partial recovery preserves completed writes and stops every remaining write', async () => {
  const f = await storageFixture();
  const changeSet = await prepare(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, { afterStep({ phase, index }) {
    if (phase === 'written' && index === 0) throw new Error('Synthetic interruption after one write');
  } }), /Synthetic interruption/);
  assert.equal((await f.memory()).content, initialMemory + proposal().after);
  assert.equal((await f.decisions()).content, initialDecisions);
  f.writes.length = 0;
  f.state.receipt = unverified();
  await assert.rejects(f.store.recover('transaction'), { code: 'ORIGINAL_SOURCE_CONFLICT' });
  assert.deepEqual(f.writes, []);
  assert.equal((await f.memory()).content, initialMemory + proposal().after);
  assert.equal((await f.decisions()).content, initialDecisions);
  assert.deepEqual((await f.store.loadJob('job')).appliedProposalIds, []);
  f.state.receipt = verified();
  assert.equal((await f.store.recover('transaction')).status, 'applied');
  assert.equal(f.writes.filter(path => path === join(memoryRoot, 'long-term.md')).length, 0);
  assert.equal(f.writes.filter(path => path === join(memoryRoot, 'decisions.md')).length, 1);
});

test('engine enriches generation and each review with fresh original receipts and keeps model role metadata intact', async t => {
  const f = await engineFixture(t);
  const job = await f.engine.dream();
  assert.equal(f.calls.generate.length, 1);
  const generated = f.calls.generate[0].sources.find(source => source.sourceId === 'journal.md');
  assert.equal(generated.originals[0].canonical.role, 'assistant');
  const result = await f.review(job);
  assert.equal(result.decision, 'accept');
  assert.equal(result.authority.policyVersion, 3);
  assert.ok(f.state.calls.length >= 4, 'Fixture attachment, generation, before review and after review all verify');
  assert.equal(f.calls.review[0][0].sources.find(source => source.sourceId === 'journal.md').originals[0].canonical.sourceKind, 'model');
  assert.equal((await f.engine.status({ jobId: job.jobId })).reviewPolicy, 'isolated-evidence-v3');
  assert.equal((await f.memory()).content, initialMemory, 'Approval alone must not write while the agent is busy');
  f.release();
  await f.engine.flush();
  assert.equal((await f.memory()).content, initialMemory + proposal().after);
  assert.equal(f.calls.compact, 0);
});

for (const unavailableVerifier of [false, true]) test(`engine cannot accept a covered unavailable original${unavailableVerifier ? ' without a configured verifier' : ' after access is revoked'}`, async t => {
  const f = await engineFixture(t, { unavailableVerifier });
  const job = await f.engine.dream();
  f.state.receipt = unverified();
  f.writes.length = 0;
  await assert.rejects(f.review(job), { code: 'ORIGINAL_SOURCE_UNVERIFIED' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await f.store.loadJob(job.jobId)).reviews, []);
  assert.equal((await f.memory()).content, initialMemory);
});

test('engine rejects a receipt changed during isolated review before persisting its acceptance', async t => {
  const f = await engineFixture(t);
  const job = await f.engine.dream();
  f.setReviewer(async (snapshot, item) => {
    f.state.receipt = verified({ canonical: { ...verified().canonical, eventHash: 'changed-during-review' } });
    return { decision: 'accept', reason: 'Stale synthetic review.', authority: syntheticCleanAuthority(snapshot, item) };
  });
  f.writes.length = 0;
  await assert.rejects(f.review(job), { code: 'STALE_REVIEW' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await f.store.loadJob(job.jobId)).reviews, []);
});

test('engine storage refuses original changes between accepted review and the idle commit', async t => {
  const f = await engineFixture(t);
  const job = await f.engine.dream();
  await f.review(job);
  f.state.receipt = unverified();
  f.writes.length = 0;
  f.release();
  await f.engine.flush();
  const stored = await f.store.loadJob(job.jobId);
  assert.equal(stored.state, 'failed');
  assert.equal(stored.error.code, 'ORIGINAL_SOURCE_CONFLICT');
  assert.deepEqual(stored.appliedProposalIds, []);
  assert.deepEqual(await f.store.listTransactions(), []);
  assert.equal((await f.memory()).content, initialMemory);
  assert.ok(f.writes.every(path => !path.startsWith(`${memoryRoot}/`)));
});

test('engine cancellation during source-aware isolated review cannot persist acceptance or memory changes', async t => {
  const f = await engineFixture(t);
  const job = await f.engine.dream();
  const controller = new AbortController();
  f.setReviewer(async (snapshot, item) => {
    controller.abort(new Error('Cancel source-aware review'));
    return { decision: 'accept', reason: 'Cancelled synthetic acceptance.', authority: syntheticCleanAuthority(snapshot, item) };
  });
  f.writes.length = 0;
  await assert.rejects(f.review(job, { signal: controller.signal }), /Cancel source-aware review/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual((await f.store.loadJob(job.jobId)).reviews, []);
  assert.equal((await f.memory()).content, initialMemory);
});

test('existing engine configurations with no original links still approve and commit without original verification', async t => {
  const f = await engineFixture(t, { configured: false, unavailableVerifier: true });
  const job = await f.engine.dream();
  assert.ok(job.snapshot.sources.every(source => source.originals === undefined));
  const accepted = await f.review(job);
  assert.equal(accepted.authority.policyVersion, 2);
  f.release();
  await f.engine.flush();
  assert.equal((await f.memory()).content, initialMemory + proposal().after);
  assert.equal((await f.store.loadJob(job.jobId)).state, 'awaiting_compaction');
});
