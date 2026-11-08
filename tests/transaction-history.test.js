import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { validateJob } from '../dist/domain/contracts.js';
import { createStore } from '../dist/storage/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const firstTime = '2026-11-05T05:30:00.000Z';
const secondTime = '2026-11-06T05:30:00.000Z';

function memoryFiles() {
  const records = new Map();
  let revision = 0, tail = Promise.resolve();
  const files = {
    async read(path, options) {
      const file = records.get(path);
      if (file && options?.maxBytes !== undefined && Buffer.byteLength(file.content) > options.maxBytes) throw new Error('Read budget exceeded');
      return file ? structuredClone(file) : null;
    },
    async write(path, content, version) {
      if (!isDeepStrictEqual(records.get(path)?.version ?? null, version)) throw Object.assign(new Error('Stale synthetic version'), { code: 'FILE_CONFLICT' });
      const next = `v${++revision}`;
      records.set(path, { content, version: next });
      return next;
    },
    async mkdir() {},
    async list(path) {
      return [...records.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map(key => ({ name: key.slice(path.length + 1), isDirectory: false }));
    },
    async stat(path) { const file = records.get(path); return file ? { type: 'file', size: Buffer.byteLength(file.content), version: file.version } : null; },
    async withLock(_key, operation) { const result = tail.then(operation); tail = result.catch(() => {}); return result; },
  };
  return { files, records };
}

async function fixture({ pendingSibling = false, precommitted = true } = {}) {
  const { files, records } = memoryFiles();
  const config = validateConfig({ sessionId: 'session', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' });
  const scope = { scopeId: 'scope', agentId: 'session', sessionId: 'session', memoryRootId: config.memoryRoot };
  const actor = { agentId: 'session', sessionId: 'session' };
  const targetPath = '/synthetic/memory/long-term.md';
  const dailyPath = '/synthetic/memory/daily/2026-11-05.md';
  const before = 'Original memory.\n';
  const targetVersion = await files.write(targetPath, before, null);
  const daily = 'Alpha happened. Beta happened.';
  const dailyVersion = await files.write(dailyPath, daily, null);
  const snapshot = {
    schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: firstTime,
    sources: [
      { sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: before, version: targetVersion, writable: true, sensitivity: 'private', protectedText: [] },
      { sourceId: 'daily', path: 'daily/2026-11-05.md', role: 'daily', content: daily, version: dailyVersion, writable: false, sensitivity: 'private', protectedText: [] },
    ],
  };
  const proposals = ['Alpha', ...(pendingSibling ? ['Beta'] : [])].map((name, index) => ({
    schemaVersion: 1, proposalId: `p${index + 1}`, jobId: 'job', kind: 'fact', text: `${name} happened.`, reason: 'Original event evidence.',
    evidence: [{ sourceId: 'daily', quote: `${name} happened.` }], targetId: 'memory', operation: 'append', before: '', after: `${name} happened.\n`,
  }));
  function review(proposal, basis, id, when, decision = 'accept') {
    return { schemaVersion: 1, reviewId: id, proposalId: proposal.proposalId, jobId: 'job', reviewer: actor, decision,
      reason: 'Synthetic isolated review.', reviewedAt: when, proposalSnapshot: structuredClone(proposal),
      basis: { scope, sources: structuredClone(basis.sources) },
      ...(decision === 'accept' ? { authority: syntheticCleanAuthority(basis, proposal, { callId: id }) } : {}),
    };
  }
  const transaction = { schemaVersion: 1, transactionId: 'tx1', jobId: 'job', proposalIds: ['p1'], reviewIds: ['r1'], status: 'prepared',
    changes: [{ targetId: 'memory', before, after: before + proposals[0].after, version: targetVersion }] };
  let time = firstTime;
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot, now: () => time });
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, state: precommitted ? 'awaiting_reload' : 'applying', proposals,
    reviews: proposals.map((proposal, index) => review(proposal, snapshot, `r${index + 1}`, firstTime, index === 0 ? 'accept' : 'defer')),
    appliedProposalIds: precommitted ? ['p1'] : [], appliedTransactionIds: precommitted ? ['tx1'] : [],
    committingProposalIds: precommitted ? [] : ['p1'], transaction, createdAt: firstTime, updatedAt: firstTime, compaction: { status: 'no_op' },
  };
  async function reload() {
    const target = await files.read(targetPath), event = await files.read(dailyPath);
    return [{ sourceId: 'memory', path: targetPath, ...target }, { sourceId: 'daily', path: dailyPath, ...event }];
  }
  if (precommitted) {
    await files.write(targetPath, transaction.changes[0].after, targetVersion);
    job.reload = { transactionId: 'tx1', status: 'ready', sources: await reload() };
  }
  await store.saveJob(job);
  const host = { async notify() {}, async requestReview() {}, async requestReload() {}, async waitForIdle() {}, async maintain(work) { return work(); }, async compact() { return null; } };
  const engine = createEngine({ config, scope, files, store, host, generate: async () => assert.fail('ACK must never rerun generation'), now: () => new Date(time) });
  const ack = async (targetEngine = engine) => {
    const current = await store.loadJob('job');
    return targetEngine.ackReload({ jobId: 'job', transactionId: current.reload.transactionId, readSourceIds: current.reload.sources.map(source => source.sourceId) }, { actor });
  };
  async function nextBatch() {
    time = secondTime;
    const current = await store.loadJob('job');
    const target = await files.read(targetPath);
    const fresh = structuredClone(current.snapshot);
    Object.assign(fresh.sources[0], target);
    fresh.snapshotId = 'snapshot-2'; fresh.capturedAt = time;
    const tx = { schemaVersion: 1, transactionId: 'tx2', jobId: 'job', proposalIds: ['p2'], reviewIds: ['r2-accepted'], status: 'prepared',
      changes: [{ targetId: 'memory', before: target.content, after: target.content + proposals[1].after, version: target.version }] };
    await files.write(targetPath, tx.changes[0].after, target.version);
    const sources = await reload();
    await store.updateJob('job', old => ({ ...old, state: 'awaiting_reload', updatedAt: time, snapshot: fresh,
      reviews: [...old.reviews, review(proposals[1], fresh, 'r2-accepted', time)], appliedProposalIds: ['p1', 'p2'], appliedTransactionIds: ['tx1', 'tx2'],
      transaction: tx, transactionWriteReceipt: undefined, reload: { transactionId: 'tx2', status: 'ready', sources }, reportDelivery: undefined,
    }));
  }
  async function commitReady(afterStep) {
    await store.commit(transaction, id => id === 'memory' ? targetPath : dailyPath, { afterStep });
    const sources = await reload();
    await store.updateJob('job', current => ({ ...current, state: 'awaiting_reload', reload: { transactionId: 'tx1', status: 'ready', sources } }));
  }
  return { files, records, config, scope, actor, store, engine, job, transaction, proposals, targetPath, dailyPath, ack, nextBatch, reload, commitReady,
    setTime(value) { time = value; },
  };
}

test('ACK appends an immutable applied transaction snapshot while preserving current transaction semantics', async () => {
  const f = await fixture();
  const before = await f.store.loadJob('job');
  assert.equal(Object.hasOwn(before, 'transactionHistory'), false);
  await f.ack();
  const job = await f.store.loadJob('job');
  assert.equal(job.state, 'completed');
  assert.equal(job.transaction.status, 'prepared', 'Existing current transaction semantics remain unchanged');
  assert.equal(job.transactionHistory.length, 1);
  const entry = job.transactionHistory[0];
  assert.deepEqual(entry.transaction, { ...before.transaction, status: 'applied' });
  assert.deepEqual(entry.reload, job.reload);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.writtenSources, undefined, 'Old completed transactions do not invent write receipts');
  assert.equal(validateJob(job), job);
  job.reload.sources[0].content = 'Caller mutation';
  assert.notEqual(job.transactionHistory[0].reload.sources[0].content, job.reload.sources[0].content);
});

test('duplicate and concurrent ACKs preserve the original entry and acknowledgement timestamp', async () => {
  const f = await fixture();
  await Promise.all([f.ack(), f.ack()]);
  const first = await f.store.loadJob('job');
  f.setTime(secondTime);
  await f.ack();
  const repeated = await f.store.loadJob('job');
  assert.deepEqual(repeated.transactionHistory, first.transactionHistory);
  assert.equal(repeated.reload.acknowledgedAt, firstTime);
});

test('two acknowledged batches survive subsequent transaction replacement and store restart', async () => {
  const f = await fixture({ pendingSibling: true });
  await f.ack();
  const first = structuredClone((await f.store.loadJob('job')).transactionHistory[0]);
  await f.nextBatch();
  const pending = await f.store.loadJob('job');
  assert.equal(pending.transaction.transactionId, 'tx2');
  assert.deepEqual(pending.transactionHistory, [first]);
  await f.ack();
  const restarted = createStore(f.files, { root: f.config.stateRoot, lockKey: f.config.memoryRoot });
  const job = await restarted.loadJob('job');
  assert.deepEqual(job.transactionHistory.map(entry => entry.transaction.transactionId), ['tx1', 'tx2']);
  assert.deepEqual(job.transactionHistory[0], first);
  assert.deepEqual(job.transactionHistory[1].transaction.proposalIds, ['p2']);
  assert.equal(job.state, 'completed');
});

test('legacy acknowledged jobs remain readable and repeated ACK does not fabricate historical entries', async () => {
  const f = await fixture();
  await f.store.updateJob('job', current => ({ ...current, state: 'completed', reload: { ...current.reload, acknowledgedAt: firstTime } }));
  await f.ack();
  const job = await f.store.loadJob('job');
  assert.equal(Object.hasOwn(job, 'transactionHistory'), false);
  assert.equal(validateJob(job), job);
});

test('history validators reject malformed identities, ledgers, reload data and timestamps', async () => {
  const f = await fixture(); await f.ack();
  const original = await f.store.loadJob('job');
  for (const modify of [
    job => { job.transactionHistory[0].schemaVersion = 2; },
    job => { job.transactionHistory[0].extra = true; },
    job => { job.transactionHistory[0].transaction.jobId = 'other'; },
    job => { job.transactionHistory[0].transaction.status = 'prepared'; },
    job => { job.transactionHistory[0].reload.transactionId = 'other'; },
    job => { job.transactionHistory[0].reload.status = 'preparing'; },
    job => { job.transactionHistory[0].reload.acknowledgedAt = 'yesterday'; },
    job => { job.transactionHistory[0].reload.acknowledgedAt = '2020-01-01T00:00:00Z'; },
    job => { job.transactionHistory[0].reload.sources.push(structuredClone(job.transactionHistory[0].reload.sources[0])); },
    job => { job.transactionHistory[0].reload.sources[0].version = undefined; },
    job => { job.transactionHistory[0].reload.sources[0].authority = 'approved'; },
    job => { job.appliedProposalIds = []; },
    job => { job.appliedTransactionIds = []; },
    job => { job.transactionHistory[0].transaction.reviewIds = ['missing-review']; },
    job => { job.transactionHistory.push(structuredClone(job.transactionHistory[0])); },
  ]) {
    const changed = structuredClone(original); modify(changed);
    assert.throws(() => validateJob(changed), TypeError);
  }
});

test('saveJob and updateJob refuse history deletion, edits and forged initial history', async () => {
  const f = await fixture(); await f.ack();
  const original = await f.store.loadJob('job');
  for (const save of [next => f.store.saveJob(next), next => f.store.updateJob('job', () => next)]) {
    for (const modify of [
      next => { delete next.transactionHistory; },
      next => { next.transactionHistory[0].reload.sources[0].content += 'Forged historical detail'; },
      next => { next.transactionHistory[0].transaction.changes[0].after += 'Forged historical edit'; },
    ]) {
      const next = structuredClone(original); modify(next);
      await assert.rejects(save(next), /append-only/);
    }
  }
  const other = memoryFiles();
  const freshStore = createStore(other.files, { root: f.config.stateRoot, lockKey: f.config.memoryRoot });
  await assert.rejects(freshStore.saveJob(original), /cannot invent/);
  assert.deepEqual(await f.store.loadJob('job'), original);
});

test('historical proposals, clean review authority and basis cannot be changed through a valid replacement record', async () => {
  const f = await fixture(); await f.ack();
  const original = await f.store.loadJob('job');
  for (const modify of [
    job => { job.reviews[0].reason = 'Reinterpreted historical approval'; },
    job => { job.reviews[0].authority.provider = 'another-provider'; },
    job => { job.proposals[0].reason = 'Reinterpreted proposal'; job.reviews[0].proposalSnapshot.reason = 'Reinterpreted proposal'; },
    job => { job.reviews[0].basis.sources[1].content += ' Another claim.'; },
  ]) {
    const next = structuredClone(original); modify(next);
    const review = next.reviews[0];
    const basis = { schemaVersion: 1, snapshotId: review.reviewId, scope: review.basis.scope, capturedAt: review.reviewedAt, sources: review.basis.sources };
    review.authority = syntheticCleanAuthority(basis, review.proposalSnapshot, { callId: review.authority.callId, provider: review.authority.provider });
    validateJob(next);
    await assert.rejects(f.store.saveJob(next), /immutable/);
  }
});

test('applied and invalidated ledgers are append-only even when no history referenced the removed ID', async () => {
  const f = await fixture({ pendingSibling: true });
  await f.store.updateJob('job', current => ({ ...current, invalidatedReviewIds: ['r2'], appliedTransactionIds: ['tx1', 'legacy-tx'] }));
  const original = await f.store.loadJob('job');
  for (const field of ['appliedProposalIds', 'appliedTransactionIds', 'invalidatedReviewIds']) {
    const next = structuredClone(original); next[field] = [];
    await assert.rejects(f.store.saveJob(next), /append-only/);
  }
});

test('new history cannot be appended with changed current transaction, reload or simultaneous ledger injection', async () => {
  for (const kind of ['transaction', 'reload', 'ledger']) {
    const f = await fixture();
    const before = await f.store.loadJob('job');
    await assert.rejects(f.store.updateJob('job', current => {
      const reload = { ...current.reload, acknowledgedAt: firstTime };
      const entry = { schemaVersion: 1, transaction: { ...current.transaction, status: 'applied' }, reload: structuredClone(reload) };
      const next = { ...current, state: 'completed', reload, transactionHistory: [entry] };
      if (kind === 'transaction') { next.transaction = { ...next.transaction, transactionId: 'injected' }; }
      if (kind === 'reload') { next.reload.sources = [{ ...next.reload.sources[0], content: 'unread content' }]; entry.reload = structuredClone(next.reload); }
      if (kind === 'ledger') next.appliedTransactionIds = [...next.appliedTransactionIds, 'injected'];
      return next;
    }), /bind the current transaction/);
    assert.deepEqual(await f.store.loadJob('job'), before);
  }
});

test('actual write-return versions are frozen before written hooks and copied only after matching ACK', async () => {
  const f = await fixture({ precommitted: false });
  let witnessed;
  await f.commitReady(async ({ phase, manifest }) => {
    if (phase !== 'written') return;
    const saved = JSON.parse((await f.files.read(`${f.config.stateRoot}/transactions/tx1/manifest.json`)).content);
    assert.deepEqual(saved.entries[0].writtenVersion, manifest.entries[0].writtenVersion);
    witnessed = manifest.entries[0].writtenVersion;
  });
  const before = await f.store.loadJob('job');
  assert.equal(before.transactionWriteReceipt.sources[0].version, witnessed);
  assert.equal(before.transactionHistory, undefined);
  await f.ack();
  const entry = (await f.store.loadJob('job')).transactionHistory[0];
  assert.deepEqual(entry.writtenSources, before.transactionWriteReceipt.sources);
  assert.deepEqual(entry.writtenSources[0], entry.reload.sources[0]);
});

test('same-byte external rewrite before reload ACK completes business state but cannot certify continuity', async () => {
  const f = await fixture({ precommitted: false });
  await f.commitReady();
  const before = await f.store.loadJob('job');
  const current = await f.files.read(f.targetPath);
  const rewrittenVersion = await f.files.write(f.targetPath, current.content, current.version);
  assert.notEqual(rewrittenVersion, before.transactionWriteReceipt.sources[0].version);
  await assert.rejects(f.ack(), /Memory changed during reload/);
  const sources = await f.reload();
  await f.store.updateJob('job', job => ({ ...job, reload: { ...job.reload, sources } }));
  await f.ack();
  const completed = await f.store.loadJob('job');
  assert.equal(completed.state, 'completed');
  assert.equal(completed.transactionHistory[0].writtenSources, undefined);
});

test('recovery after a failed receipt save never invents a write-return version from an after-image', async () => {
  const f = await fixture({ precommitted: false });
  const originalWrite = f.files.write;
  let interrupted = false;
  f.files.write = async (path, content, version) => {
    if (!interrupted && path.endsWith('/manifest.json') && JSON.parse(content).entries?.[0]?.writtenVersion !== undefined) {
      interrupted = true; throw new Error('Crash before write receipt persisted');
    }
    return originalWrite(path, content, version);
  };
  await assert.rejects(f.store.commit(f.transaction, id => id === 'memory' ? f.targetPath : f.dailyPath), /Crash before write receipt/);
  f.files.write = originalWrite;
  await f.store.recover('tx1');
  const recovered = await f.store.loadJob('job');
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.transactionWriteReceipt, undefined);
  const sources = await f.reload();
  await f.store.updateJob('job', job => ({ ...job, state: 'awaiting_reload', reload: { transactionId: 'tx1', status: 'ready', sources } }));
  await f.ack();
  assert.equal((await f.store.loadJob('job')).transactionHistory[0].writtenSources, undefined);
});

test('public job saves cannot fabricate, overwrite or erase current write receipts', async () => {
  const old = await fixture();
  const current = await old.store.loadJob('job');
  current.transactionWriteReceipt = { transactionId: 'tx1', sources: [current.reload.sources[0]] };
  await assert.rejects(old.store.saveJob(current), /only be recorded by storage completion/);
  const f = await fixture({ precommitted: false }); await f.commitReady();
  const before = await f.store.loadJob('job');
  for (const modify of [
    next => { delete next.transactionWriteReceipt; },
    next => { next.transactionWriteReceipt.sources[0].version = 'forged-version'; },
  ]) {
    const next = structuredClone(before); modify(next);
    await assert.rejects(f.store.saveJob(next), /only be recorded by storage completion/);
  }
  assert.deepEqual(await f.store.loadJob('job'), before);
});
