import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import test from 'node:test';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { createStore } from '../dist/storage/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const stamp = '2026-11-05T05:30:00.000Z';
const actor = { agentId: 'synthetic', sessionId: 'synthetic' };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, { reload = false, contents = ['Current A.\n', 'Current B.\n'], decisions = ['accept', 'defer'] } = {}) {
  const records = new Map(), writes = [], reads = [];
  let revision = 0, queue = Promise.resolve(), storageDepth = 0;
  const files = {
    async read(path, options) {
      reads.push({ path, options }); options?.signal?.throwIfAborted();
      const file = records.get(path);
      if (file && options?.maxBytes !== undefined && Buffer.byteLength(file.content) > options.maxBytes) throw Object.assign(new Error('Too large'), { code: 'FS_TOO_LARGE' });
      return file ? structuredClone(file) : null;
    },
    async write(path, content, version) {
      assert.deepEqual(records.get(path)?.version ?? null, version);
      const next = `version-${++revision}`; records.set(path, { content, version: next }); writes.push(path); return next;
    },
    async mkdir() {}, async stat(path) { const file = records.get(path); return file ? { type: 'file', size: Buffer.byteLength(file.content), version: file.version } : null; },
    async list(path) { return [...records.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map(key => ({ name: key.slice(path.length + 1), isDirectory: false })); },
    async withLock(_key, operation) { const result = queue.then(async () => { storageDepth++; try { return await operation(); } finally { storageDepth--; } }); queue = result.catch(() => {}); return result; },
  };
  const config = validateConfig({ sessionId: 'synthetic', memoryRoot: '/fixture/memory', stateRoot: '/fixture/state', dreamMode: 'off' });
  const scope = { scopeId: 'scope', ...actor, memoryRootId: config.memoryRoot };
  const paths = ['/fixture/memory/long-term.md', '/fixture/memory/daily/2026-11-05.md'];
  for (const [index, path] of paths.entries()) await files.write(path, reload ? contents[index] : index ? 'Alpha happened. Beta happened.' : 'Original memory.\n', null);
  const sources = [];
  for (const [index, path] of paths.entries()) sources.push({ sourceId: index ? 'daily' : 'memory', path: index ? 'daily/2026-11-05.md' : 'long-term.md', role: index ? 'daily' : 'longTerm', writable: !index, sensitivity: 'private', protectedText: [], ...await files.read(path) });
  const snapshot = { schemaVersion: 1, snapshotId: 'initial', scope, capturedAt: stamp, sources };
  const proposals = ['Alpha', 'Beta'].map((name, index) => ({ schemaVersion: 1, jobId: 'job', proposalId: `p${index + 1}`, kind: 'fact', text: `${name} happened.`, reason: 'Source reports event.', evidence: [{ sourceId: 'daily', quote: `${name} happened.` }], targetId: 'memory', operation: 'append', before: '', after: `${name} happened.\n` }));
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, state: reload ? 'awaiting_reload' : 'awaiting_review', proposals: reload ? [] : proposals, reviews: [], appliedProposalIds: [], createdAt: stamp, updatedAt: stamp };
  if (reload) {
    Object.assign(job, { transaction: { schemaVersion: 1, transactionId: 'tx', jobId: 'job', status: 'prepared', proposalIds: [], reviewIds: [], changes: [{ targetId: 'memory', before: 'Before', after: contents[0], version: 'old-version' }] }, compaction: { status: 'no_op' }, reload: { transactionId: 'tx', status: 'ready', sources: sources.map((source, index) => ({ sourceId: source.sourceId, path: paths[index], content: source.content, version: source.version })) } });
    // ACK tests below use an accepted historical proposal to satisfy transaction history.
    const prior = { ...proposals[0], evidence: [{ sourceId: 'daily', quote: contents[1] }], after: contents[0] };
    const basis = structuredClone(snapshot); basis.sources[0].content = 'Before'; basis.sources[0].version = 'old-version';
    prior.operation = 'replace'; prior.before = 'Before';
    job.proposals = [prior]; job.appliedProposalIds = [prior.proposalId]; job.appliedTransactionIds = ['tx'];
    job.transaction.proposalIds = [prior.proposalId]; job.transaction.reviewIds = ['prior-review'];
    job.reviews = [{ schemaVersion: 1, reviewId: 'prior-review', jobId: 'job', proposalId: prior.proposalId, reviewer: actor, decision: 'accept', reason: 'Synthetic prior independent review.', reviewedAt: stamp, proposalSnapshot: structuredClone(prior), basis: { scope, sources: basis.sources }, authority: syntheticCleanAuthority(basis, prior) }];
  }
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot, now: () => stamp });
  await store.saveJob(job);
  const gate = deferred();
  const controller = new AbortController();
  const calls = [], notifications = [];
  let behavior = async (basis, proposal) => ({ decision: decisions[Number(proposal.proposalId.slice(1)) - 1] ?? 'accept', reason: `Independent ${proposal.proposalId}.`, authority: syntheticCleanAuthority(basis, proposal, { callId: `clean-${calls.length}-${proposal.proposalId}` }) });
  let sequence = 0;
  const make = () => createEngine({ config, scope, files, store, signal: controller.signal, now: () => new Date(stamp), id: () => `host-id-${++sequence}`,
    generate: async () => assert.fail('Maintenance must not invoke generation'),
    cleanReview: async (basis, proposal, options) => { assert.equal(storageDepth, 0); calls.push({ basis, proposal, options }); return behavior(basis, proposal, options); },
    host: { async waitForIdle() { await gate.promise; }, async maintain(work) { return work(controller.signal); }, async compact() { return null; }, async requestReview() {}, async requestReload() {}, async notify(text) { notifications.push(text); } },
  });
  const engine = make();
  const instances = [engine];
  t.after(async () => { controller.abort(new Error('Synthetic cleanup')); gate.resolve(); await Promise.all(instances.map(instance => instance.flush())); });
  writes.length = 0; reads.length = 0;
  return { files, store, engine, calls, records, writes, reads, job, paths, controller, notifications, releaseIdle: () => gate.resolve(),
    setReviewer(fn) { behavior = fn; }, restart() { const next = make(); instances.push(next); return next; },
  };
}

const batch = { jobId: 'job', proposalIds: ['p1', 'p2'] };

test('batch performs separate clean calls on one snapshot and persists all decisions in one CAS', async t => {
  const f = await fixture(t);
  const result = await f.engine.reviewBatch(batch, { actor });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].basis, f.calls[1].basis);
  assert.notEqual(f.calls[0].basis, f.calls[1].basis, 'Each reviewer gets its own detached snapshot');
  assert.deepEqual(f.calls.map(call => call.proposal.proposalId), ['p1', 'p2']);
  assert.equal(new Set(result.results.map(item => item.authority.callId)).size, 2);
  assert.deepEqual(result.reviewedProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.remainingUnreviewedIds, []);
  assert.deepEqual(result.results.map(item => item.decision), ['accept', 'defer']);
  const job = await f.store.loadJob('job');
  assert.equal(job.reviews.length, 2);
  assert.equal(f.writes.filter(path => path.endsWith('/jobs/job.json')).length, 1);
  assert.ok(f.reads.filter(read => f.paths.includes(read.path)).every(read => read.options?.signal instanceof AbortSignal));
  assert.equal((await f.files.read(f.paths[0])).content, 'Original memory.\n');
});

test('fresh accepted and deferred batch decisions reuse exact authority without another clean call', async t => {
  const f = await fixture(t);
  const first = await f.engine.reviewBatch(batch, { actor });
  const before = await f.store.loadJob('job');
  const second = await f.engine.reviewBatch(batch, { actor });
  assert.equal(f.calls.length, 2);
  assert.ok(first.results.every(result => result.reused === false));
  assert.ok(second.results.every(result => result.reused === true));
  assert.deepEqual(second.results.map(result => result.authority), first.results.map(result => result.authority));
  assert.deepEqual((await f.store.loadJob('job')).reviews, before.reviews);
  assert.deepEqual(second.remainingUnreviewedIds, []);
});

test('changed source evidence prevents deferred decision reuse and triggers a fresh independent call', async t => {
  const f = await fixture(t, { decisions: ['defer', 'defer'] });
  await f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor });
  const previous = await f.files.read(f.paths[1]);
  await f.files.write(f.paths[1], `${previous.content} Additional original context.`, previous.version);
  const result = await f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor });
  assert.equal(f.calls.length, 2);
  assert.equal(result.results[0].reused, false);
  assert.equal((await f.store.loadJob('job')).reviews.length, 2);
});

test('partial explicit batches report unreviewed siblings without granting their approval', async t => {
  const f = await fixture(t);
  const result = await f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor });
  assert.deepEqual(result.remainingUnreviewedIds, ['p2']);
  assert.equal((await f.store.loadJob('job')).reviews.length, 1);
});

test('invalid IDs, authority fields, scope and closed jobs fail before model dispatch', async t => {
  for (const proposalIds of [[], ['p1', 'p1'], ['missing'], Array.from({ length: 33 }, (_, index) => `p${index}`)]) {
    const f = await fixture(t);
    await assert.rejects(f.engine.reviewBatch({ jobId: 'job', proposalIds }, { actor }));
    assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t);
  await assert.rejects(f.engine.reviewBatch({ ...batch, decision: 'accept' }, { actor }), /explicit proposal IDs/);
  await assert.rejects(f.engine.reviewBatch(batch, { actor: { ...actor, sessionId: 'other' } }), /scope/);
  await f.store.updateJob('job', job => ({ ...job, state: 'completed', appliedProposalIds: ['p1', 'p2'] }));
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /not open/);
  assert.equal(f.calls.length, 0);
});

test('model failure or reused call identity never persists a partially accepted batch', async t => {
  for (const reused of [false, true]) {
    const f = await fixture(t);
    f.setReviewer(async (basis, proposal) => {
      if (!reused && proposal.proposalId === 'p2') throw new Error('Synthetic provider failure');
      return { decision: 'accept', reason: 'Synthetic review.', authority: syntheticCleanAuthority(basis, proposal, { callId: 'same-call' }) };
    });
    await assert.rejects(f.engine.reviewBatch(batch, { actor }), /provider failure|distinct independent/);
    assert.deepEqual((await f.store.loadJob('job')).reviews, []);
    assert.equal(f.writes.length, 0);
  }
});

test('a rejected first item survives later failure and blocks reordered batches, single reviews and restart', async t => {
  const f = await fixture(t);
  const before = await f.store.loadJob('job');
  const source = await f.files.read(f.paths[1]);
  await f.files.write(f.paths[1], `${source.content} New original context before review.`, source.version);
  f.setReviewer(async (basis, proposal) => {
    if (proposal.proposalId === 'p2') throw new Error('Second reviewer failed');
    return { decision: 'reject', reason: 'The edit is unsupported.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /Second reviewer failed/);
  const job = await f.store.loadJob('job');
  assert.deepEqual(job.snapshot, before.snapshot, 'Failed batch must not overwrite the current snapshot');
  assert.deepEqual(job.proposals, before.proposals, 'Failed batch must not replace current proposal metadata');
  assert.equal(job.state, before.state);
  assert.deepEqual(job.reviews.map(review => review.decision), ['reject']);
  assert.ok(job.reviews[0].proposalSnapshot.lineage);
  assert.match(job.reviews[0].basis.sources.find(item => item.sourceId === 'daily').content, /New original context/);
  assert.equal((await f.store.listRejected()).length, 1);
  const calls = f.calls.length;
  await assert.rejects(f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p2', 'p1'] }, { actor }), /cannot be rerolled/);
  await assert.rejects(f.engine.review({ jobId: 'job', proposalId: 'p1', decision: 'review', reason: 'Try again' }, { actor }), /cannot be rerolled/);
  await assert.rejects(f.restart().reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor }), /cannot be rerolled/);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(job.appliedProposalIds, []);
  assert.equal((await f.files.read(f.paths[0])).content, 'Original memory.\n');
});

test('a historical veto is terminal for batch progress after its remaining sibling is reviewed', async t => {
  const f = await fixture(t);
  const source = await f.files.read(f.paths[1]);
  await f.files.write(f.paths[1], `${source.content} Refreshed source lineage.`, source.version);
  f.setReviewer(async (basis, proposal) => {
    if (proposal.proposalId === 'p2') throw new Error('Second reviewer unavailable');
    return { decision: 'reject', reason: 'Unsupported edit.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /Second reviewer unavailable/);
  const historical = await f.store.loadJob('job');
  assert.notDeepEqual(historical.reviews[0].proposalSnapshot.lineage, historical.proposals[0].lineage);
  f.setReviewer(async (basis, proposal) => ({ decision: 'defer', reason: 'Sibling remains uncertain.', authority: syntheticCleanAuthority(basis, proposal) }));
  const result = await f.restart().reviewBatch({ jobId: 'job', proposalIds: ['p2'] }, { actor });
  assert.deepEqual(result.reviewedProposalIds, ['p2']);
  assert.deepEqual(result.remainingUnreviewedIds, []);
  assert.deepEqual((await f.store.loadJob('job')).reviews.map(review => review.decision), ['reject', 'defer']);
  assert.equal(f.calls.length, 3);
  await assert.rejects(f.engine.review({ jobId: 'job', proposalId: 'p1', decision: 'review', reason: 'Still forbidden' }, { actor }), /cannot be rerolled/);
});

test('failed-batch historical rejection settles through real submission and sibling commit/reload ACK', async t => {
  for (const outcome of ['reject', 'accept']) {
    const f = await fixture(t), source = await f.files.read(f.paths[1]);
    await f.files.write(f.paths[1], source.content + ' Refreshed source context.', source.version);
    f.setReviewer(async (basis, proposal) => {
      if (proposal.proposalId === 'p2') throw new Error('Transient second-review failure');
      return { decision: 'reject', reason: 'Historical unsupported edit.', authority: syntheticCleanAuthority(basis, proposal) };
    });
    await assert.rejects(f.engine.reviewBatch(batch, { actor }), /second-review failure/);
    f.setReviewer(async (basis, proposal) => ({ decision: outcome, reason: 'Remaining sibling decision.', authority: syntheticCleanAuthority(basis, proposal) }));
    // This regression now executes the real post-commit collector, unlike the
    // earlier blocked-idle unit cases. Supply its required synthetic directories.
    const originalStat = f.files.stat;
    f.files.stat = async path => ['/fixture/memory/daily', '/fixture/memory/ideas'].includes(path) ? { type: 'directory' } : originalStat(path);
    for (const name of ['decisions.md', 'journal.md']) await f.files.write('/fixture/memory/' + name, '# Synthetic empty source\n', null);
    const engine = f.restart(); await engine.reviewBatch({ jobId: 'job', proposalIds: ['p2'] }, { actor });
    f.releaseIdle(); await engine.flush();
    let job = await f.store.loadJob('job');
    if (outcome === 'reject') { assert.equal(job.state, 'reviewed_no_changes'); assert.deepEqual(job.appliedProposalIds, []); }
    else {
      assert.equal(job.state, 'awaiting_reload', JSON.stringify(job.error)); assert.deepEqual(job.appliedProposalIds, ['p2']);
      const read = await engine.readReload({ jobId: 'job', transactionId: job.reload.transactionId }, { actor, callId: 'after-write-read' });
      const ack = await engine.ackReload({ jobId: 'job', transactionId: job.reload.transactionId, readReceiptIds: [read.readReceiptId] }, { actor, callId: 'later-ack' });
      assert.equal(ack.state, 'completed'); job = await f.store.loadJob('job'); assert.equal(job.transactionHistory.length, 1);
      assert.match((await f.files.read(f.paths[0])).content, /Beta happened/); assert.doesNotMatch((await f.files.read(f.paths[0])).content, /Alpha happened/);
    }
    assert.equal(job.reviews.filter(r => r.proposalId === 'p1' && r.decision === 'reject').length, 1);
  }
});

test('failed-batch defer remains historical, is reused for the same evidence and can be re-reviewed after evidence changes', async t => {
  const f = await fixture(t);
  f.setReviewer(async (basis, proposal) => {
    if (proposal.proposalId === 'p2') throw new Error('Later reviewer unavailable');
    return { decision: 'defer', reason: 'More evidence is needed.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /Later reviewer unavailable/);
  const first = await f.store.loadJob('job');
  assert.deepEqual(first.reviews.map(review => review.decision), ['defer']);
  assert.deepEqual(first.snapshot, f.job.snapshot);
  const reused = await f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor });
  assert.equal(reused.results[0].reused, true);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.store.loadJob('job')).reviews.length, 1);
  const source = await f.files.read(f.paths[1]); await f.files.write(f.paths[1], source.content + ' Additional corroborating source detail.', source.version);
  const fresh = await f.engine.reviewBatch({ jobId: 'job', proposalIds: ['p1'] }, { actor });
  assert.equal(fresh.results[0].reused, false);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.store.loadJob('job')).reviews.length, 2);
});

test('abort after a validated reject persists the veto without recording partial accepts', async t => {
  const f = await fixture(t); const abort = new AbortController();
  f.setReviewer(async (basis, proposal) => {
    abort.abort(new Error('Stop after first verdict'));
    return { decision: 'reject', reason: 'Observed refusal.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor, signal: abort.signal }), /Stop after first verdict/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.store.loadJob('job')).reviews.map(review => review.decision), ['reject']);
  await assert.rejects(f.engine.review({ jobId: 'job', proposalId: 'p1', decision: 'review', reason: 'Retry' }, { actor }), /cannot be rerolled/);
});

test('stale-source or stale-job batch failure appends only historical non-approval without clobbering newer state', async t => {
  for (const mutation of ['source', 'job']) {
    const f = await fixture(t);
    f.setReviewer(async (basis, proposal) => {
      if (proposal.proposalId === 'p2') {
        if (mutation === 'source') { const source = await f.files.read(f.paths[1]); await f.files.write(f.paths[1], source.content + ' Concurrent correction.', source.version); }
        else await f.store.updateJob('job', job => ({ ...job, recovery: { action: 'newer', message: 'Do not overwrite this state.' } }));
      }
      return { decision: proposal.proposalId === 'p1' ? 'reject' : 'accept', reason: 'Independent result.', authority: syntheticCleanAuthority(basis, proposal) };
    });
    await assert.rejects(f.engine.reviewBatch(batch, { actor }), { code: 'STALE_REVIEW' });
    const job = await f.store.loadJob('job');
    assert.deepEqual(job.reviews.map(review => review.decision), ['reject']);
    assert.deepEqual(job.snapshot, f.job.snapshot);
    if (mutation === 'job') assert.equal(job.recovery.action, 'newer');
    assert.deepEqual(job.appliedProposalIds, []);
  }
});

test('late rejected results for a concurrently committed proposal are audit-only', async t => {
  const f = await fixture(t);
  f.setReviewer(async (basis, proposal) => {
    if (proposal.proposalId === 'p2') { await f.store.updateJob('job', job => ({ ...job, appliedProposalIds: ['p1'] })); throw new Error('Later provider failed'); }
    return { decision: 'reject', reason: 'Late refusal.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /Later provider failed/);
  const job = await f.store.loadJob('job');
  assert.deepEqual(job.reviews, []);
  assert.deepEqual(job.appliedProposalIds, ['p1']);
  assert.equal((await f.store.listRejected()).length, 1);
});

test('failure to preserve a validated veto surfaces both original and persistence errors', async t => {
  const f = await fixture(t); const originalWrite = f.files.write;
  f.setReviewer(async (basis, proposal) => {
    if (proposal.proposalId === 'p2') {
      f.files.write = async (path, content, version) => { if (path.endsWith('/jobs/job.json')) throw new Error('Veto persistence failed'); return originalWrite(path, content, version); };
      throw new Error('Original model failure');
    }
    return { decision: 'reject', reason: 'Validated refusal.', authority: syntheticCleanAuthority(basis, proposal) };
  });
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /Original model failure/);
    assert.match(error.errors[1].message, /Veto persistence failed/);
    return true;
  });
  f.files.write = originalWrite;
});

test('batch gate prevents concurrent clean calls while direct veto makes the entire batch stale', async t => {
  const f = await fixture(t);
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  f.setReviewer(async (basis, proposal) => { entered.resolve(); await release.promise; return { decision: 'accept', reason: 'Paused.', authority: syntheticCleanAuthority(basis, proposal) }; });
  const pending = f.engine.reviewBatch(batch, { actor });
  const rejected = assert.rejects(pending, { code: 'STALE_REVIEW' });
  await entered.promise;
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /already running/);
  await assert.rejects(f.engine.review({ jobId: 'job', proposalId: 'p1', decision: 'review', reason: 'Must not reach model' }, { actor }), /already running/);
  await f.engine.review({ jobId: 'job', proposalId: 'p1', decision: 'reject', reason: 'Explicit veto' }, { actor });
  release.resolve(); await rejected;
  const job = await f.store.loadJob('job');
  assert.deepEqual(job.reviews.map(review => review.decision), ['reject']);
  await assert.rejects(f.engine.reviewBatch(batch, { actor }), /cannot be rerolled/);
});

test('source or unrelated job updates invalidate all batch outcomes', async t => {
  for (const mutation of ['source', 'job']) {
    const f = await fixture(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    f.setReviewer(async (basis, proposal) => { entered.resolve(); await release.promise; return { decision: 'accept', reason: 'Paused.', authority: syntheticCleanAuthority(basis, proposal) }; });
    const pending = f.engine.reviewBatch(batch, { actor }); const rejected = assert.rejects(pending, { code: 'STALE_REVIEW' }); await entered.promise;
    if (mutation === 'source') { const file = await f.files.read(f.paths[1]); await f.files.write(f.paths[1], file.content + 'External change.', file.version); }
    else await f.store.updateJob('job', job => ({ ...job, recovery: { action: 'inspection', message: 'Concurrent state change' } }));
    release.resolve(); await rejected;
    assert.deepEqual((await f.store.loadJob('job')).reviews, []);
  }
});

test('abort stops later calls, waits for the running reviewer and leaves no partial review', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const abort = new AbortController();
  f.setReviewer(async (basis, proposal, options) => { entered.resolve(options.signal); await release.promise; return { decision: 'accept', reason: 'Late response.', authority: syntheticCleanAuthority(basis, proposal) }; });
  const pending = f.engine.reviewBatch(batch, { actor, signal: abort.signal }); const rejected = assert.rejects(pending, /Cancel batch/);
  const modelSignal = await entered.promise; abort.abort(new Error('Cancel batch')); assert.equal(modelSignal.aborted, true);
  let flushed = false; const flushing = f.engine.flush().then(() => { flushed = true; }); await new Promise(setImmediate); assert.equal(flushed, false);
  release.resolve(); await rejected; await flushing;
  assert.equal(f.calls.length, 1); assert.deepEqual((await f.store.loadJob('job')).reviews, []);
});

test('reload read returns actual full text and an unpredictable detached nonce without writing job state', async t => {
  const f = await fixture(t, { reload: true });
  const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor, callId: 'read-call' });
  assert.equal(result.sources.length, 2); assert.deepEqual(result.remainingSourceIds, []);
  assert.match(result.readReceiptId, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(result.readReceiptId, /host-id/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  assert.equal(f.writes.length, 0);
  for (const source of result.sources) assert.deepEqual(await f.files.read(source.path), { content: source.content, version: source.version });
  result.sources[0].content = 'Caller mutation';
  await f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor, callId: 'later-ack-call' });
  assert.equal((await f.store.loadJob('job')).state, 'completed');
});

test('split reads combine exact receipt coverage and cannot be supplemented by unproved source claims', async t => {
  const f = await fixture(t, { reload: true });
  const one = await f.engine.readReload({ jobId: 'job', transactionId: 'tx', sourceIds: ['memory'] }, { actor, callId: 'one' });
  assert.deepEqual(one.remainingSourceIds, []);
  assert.deepEqual(one.requestedSourceIds, ['memory']); assert.deepEqual(one.allSourceIds, ['memory', 'daily']);
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [one.readReceiptId], readSourceIds: ['memory', 'daily'] }, { actor, callId: 'ack' }), /cannot extend/);
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [one.readReceiptId] }, { actor, callId: 'ack' }), /incomplete/);
  const two = await f.engine.readReload({ jobId: 'job', transactionId: 'tx', sourceIds: ['daily'] }, { actor, callId: 'two' });
  await f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [one.readReceiptId, two.readReceiptId] }, { actor, callId: 'ack' });
  assert.equal((await f.store.loadJob('job')).transactionHistory.length, 1);
});

test('forged, same-call, wrong-actor and restarted-engine nonces cannot acknowledge', async t => {
  const f = await fixture(t, { reload: true });
  const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor, callId: 'same-call' });
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: ['forged'] }, { actor, callId: 'ack' }), /Unknown/);
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor, callId: 'same-call' }), /wrong-call/);
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor: { ...actor, agentId: 'other' }, callId: 'ack' }), /scope/);
  await assert.rejects(f.restart().ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor, callId: 'ack' }), /Unknown/);
  assert.equal((await f.store.loadJob('job')).transactionHistory, undefined);
});

test('reload read budgets omit complete items and disclose the remainder instead of clipping text', async t => {
  const f = await fixture(t, { reload: true, contents: ['A'.repeat(40000), 'B'.repeat(40000)] });
  const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor });
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].content.length, 40000);
  assert.deepEqual(result.remainingSourceIds, ['daily']);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  const next = await f.engine.readReload({ jobId: 'job', transactionId: 'tx', sourceIds: result.remainingSourceIds }, { actor });
  assert.deepEqual(next.remainingSourceIds, [], 'Explicit remaining batch must not list earlier completed requests again');
  assert.equal(next.sources[0].content, 'B'.repeat(40000));
  await f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId, next.readReceiptId] }, { actor });
  assert.equal((await f.store.loadJob('job')).state, 'completed');
  const oversized = await fixture(t, { reload: true, contents: ['界'.repeat(30000), 'small'] });
  await assert.rejects(oversized.engine.readReload({ jobId: 'job', transactionId: 'tx', sourceIds: ['memory'] }, { actor }), /No complete.*fits/);
  assert.equal(oversized.reads.some(read => read.path === oversized.paths[0]), false);
});

test('PTC child calls cannot read and acknowledge receipts before a later model request', async t => {
  const f = await fixture(t, { reload: true });
  await assert.rejects(f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor, callId: 'child-read', parent: {} }), /direct native request/);
  const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor, callId: 'direct-read' });
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor, callId: 'child-ack', parent: {} }), /later direct native request/);
  assert.equal((await f.store.loadJob('job')).reload.acknowledgedAt, undefined);
});

test('stale bytes or versions and refreshed reload metadata invalidate receipt ACK', async t => {
  for (const kind of ['bytes', 'version', 'reload']) {
    const f = await fixture(t, { reload: true });
    const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor });
    if (kind === 'reload') await f.store.updateJob('job', job => ({ ...job, reloadDelivery: { messageId: 'renewed', state: 'sent', at: stamp } }));
    else { const current = await f.files.read(f.paths[0]); await f.files.write(f.paths[0], kind === 'bytes' ? current.content + 'changed' : current.content, current.version); }
    await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor }), /stale|Memory changed/);
    assert.equal((await f.store.loadJob('job')).transactionHistory, undefined);
  }
});

test('renewed delivery racing with ACK source reads cannot use earlier read tokens', async t => {
  const f = await fixture(t, { reload: true });
  const result = await f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor });
  const originalRead = f.files.read;
  let changed = false;
  f.files.read = async (path, options) => {
    const value = await originalRead(path, options);
    if (path === f.paths[0] && !changed) {
      changed = true;
      await f.store.updateJob('job', job => ({ ...job, reloadDelivery: { messageId: 'concurrent-renewal', state: 'sent', at: stamp } }));
    }
    return value;
  };
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [result.readReceiptId] }, { actor }), /read receipts changed/);
  assert.equal((await f.store.loadJob('job')).transactionHistory, undefined);
});

test('receipt hashes bind the whole ready reload even when only one source was returned', async t => {
  const f = await fixture(t, { reload: true });
  const one = await f.engine.readReload({ jobId: 'job', transactionId: 'tx', sourceIds: ['memory'] }, { actor });
  await f.store.updateJob('job', job => ({ ...job, reload: { ...job.reload, sources: job.reload.sources.map(source => source.sourceId === 'daily' ? { ...source, version: 'renewed-unread-source' } : source) } }));
  await assert.rejects(f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readReceiptIds: [one.readReceiptId] }, { actor }), /Unknown, stale/);
  assert.equal((await f.store.loadJob('job')).transactionHistory, undefined);
});

test('aborted read cannot issue a receipt and forwards cancellation to the actual filesystem call', async t => {
  const f = await fixture(t, { reload: true }); const abort = new AbortController(); const read = f.files.read;
  let sawSignal = false;
  f.files.read = async (path, options) => { const result = await read(path, options); if (path === f.paths[0]) { sawSignal = options.signal instanceof AbortSignal; abort.abort(new Error('Read cancelled')); } return result; };
  await assert.rejects(f.engine.readReload({ jobId: 'job', transactionId: 'tx' }, { actor, signal: abort.signal }), /Read cancelled/);
  assert.equal(sawSignal, true); assert.equal(f.writes.length, 0);
  assert.equal((await f.store.loadJob('job')).reload.acknowledgedAt, undefined);
});

test('legacy actual-file-read acknowledgements remain accepted without ephemeral tokens', async t => {
  const f = await fixture(t, { reload: true });
  await f.engine.ackReload({ jobId: 'job', transactionId: 'tx', readSourceIds: ['memory', 'daily'] }, { actor });
  assert.equal((await f.store.loadJob('job')).state, 'completed');
});
