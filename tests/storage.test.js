import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { applyProposal } from '../dist/domain/contracts.js';
import { recordReview } from '../dist/review/index.js';
import { transition } from '../dist/domain/state-machine.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const generated = fileURLToPath(new URL('./.tmp/', import.meta.url));
const now = '2026-10-26T05:10:00+09:00';
const scope = { scopeId: 'fixture', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' };

async function fixture(t) {
  await mkdir(generated, { recursive: true });
  const directory = await mkdtemp(join(generated, 'storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = createLocalFiles(directory);
  const store = createStore(files, { root: 'state', lockKey: 'memory', now: () => now });
  const sources = [
    { sourceId: 'journal', path: 'memory/journal.md', role: 'journal', content: 'Today I learned alpha and beta.', writable: false },
    { sourceId: 'one', path: 'memory/long-term.md', role: 'longTerm', content: 'Original one.\n', writable: true },
    { sourceId: 'two', path: 'memory/decisions.md', role: 'decisions', content: 'Original two.\n', writable: true },
  ].map((source) => ({ ...source, version: source.content, sensitivity: 'private', protectedText: [] }));
  for (const source of sources) await files.write(source.path, source.content, null);
  const proposals = ['one', 'two'].map((targetId) => ({
    schemaVersion: 1, proposalId: `proposal-${targetId}`, jobId: 'job', kind: 'fact',
    text: `Remember ${targetId}`, reason: 'A recorded event supports this update.',
    evidence: [{ sourceId: 'journal', quote: 'I learned alpha and beta' }],
    targetId, operation: 'append', before: '', after: `Accepted ${targetId}.\n`,
  }));
  const job = {
    schemaVersion: 1, jobId: 'job', scope, state: 'awaiting_review',
    snapshot: { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: now, sources },
    proposals, reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now,
  };
  const resolveTarget = (id) => sources.find((source) => source.sourceId === id)?.path;
  return { directory, files, store, job, resolveTarget };
}

async function reviewed(fixture, decisions = ['accept', 'accept']) {
  let { job } = fixture;
  for (const [index, proposal] of job.proposals.entries()) {
    job = recordReview(job, { proposalId: proposal.proposalId, decision: decisions[index], reason: 'Fixture decision.' },
      scope, { reviewId: `review-${index}`, now,
        authority: decisions[index] === 'accept' ? syntheticCleanAuthority(job.snapshot, proposal) : undefined });
  }
  const proposalIds = job.proposals.filter((_, index) => decisions[index] === 'accept').map((proposal) => proposal.proposalId);
  job = transition(job, 'prepared', { now, proposalIds });
  job = transition(job, 'applying', { now, proposalIds });
  await fixture.store.saveJob(job);
  const changeSet = {
    schemaVersion: 1, transactionId: 'transaction', jobId: job.jobId, proposalIds,
    reviewIds: proposalIds.map((id) => job.reviews.find((review) => review.proposalId === id).reviewId),
    status: 'prepared', changes: proposalIds.map((id) => {
      const proposal = job.proposals.find((item) => item.proposalId === id);
      const source = job.snapshot.sources.find((item) => item.sourceId === proposal.targetId);
      return { targetId: source.sourceId, before: source.content, after: applyProposal(source.content, proposal), version: source.version };
    }),
  };
  return { job, changeSet };
}

test('admitted budget remains fixed after a partial write across configuration changes', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, { afterStep: ({ phase, index }) => {
    if (phase === 'written' && index === 0) throw new Error('Synthetic crash');
  } }), /Synthetic crash/);
  const resumed = createStore(f.files, { root: 'state', lockKey: 'memory', changeBudget: { maxChangeBytes: 1, maxPromotions: 1 }, now: () => now });
  const recovered = await resumed.recover(changeSet.transactionId);
  assert.equal(recovered.status, 'applied');
  assert.equal((await f.store.loadJob('job')).appliedProposalIds.length, 2);
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\nAccepted two.\n');
});

test('changed candidate view prevents a new write before any memory target changes', async (t) => {
  const f = await fixture(t);
  f.job.snapshot.candidates = { items: [], total: 0, truncated: false };
  const { changeSet } = await reviewed(f);
  const other = structuredClone(f.job);
  other.jobId = 'other'; other.snapshot.snapshotId = 'other-snapshot';
  other.proposals = [{ ...other.proposals[0], jobId: 'other', proposalId: 'other-proposal', consolidation: { action: 'add', claimKey: 'new-candidate', applicability: { topic: 'fixture', conditions: 'only fixture' }, basis: 'observation' } }];
  await f.store.saveJob(other);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'CANDIDATE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
  assert.deepEqual(await f.store.listTransactions(), []);
});

test('local files reject path escapes, symlinks and stale or concurrent writes', async (t) => {
  const { directory, files } = await fixture(t);
  await assert.rejects(files.read('../outside'), { code: 'PATH_NOT_ALLOWED' });
  await assert.rejects(files.write('/outside', 'bad', null), { code: 'PATH_NOT_ALLOWED' });
  await symlink('memory/journal.md', join(directory, 'link.md'));
  await assert.rejects(files.read('link.md'), { code: 'PATH_NOT_ALLOWED' });
  const current = await files.read('memory/long-term.md');
  const writes = await Promise.allSettled([
    files.write('memory/long-term.md', 'First', current.version),
    files.write('memory/long-term.md', 'Second', current.version),
  ]);
  assert.equal(writes.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(writes.find((entry) => entry.status === 'rejected').reason.code, 'FILE_CONFLICT');
  await assert.rejects(files.write('memory/long-term.md', 'Created again', null), { code: 'FILE_CONFLICT' });
});

test('stat distinguishes directories, files and missing paths within the same confinement', async (t) => {
  const { directory, files } = await fixture(t);
  assert.equal((await files.stat('memory')).type, 'directory');
  assert.deepEqual(await files.stat('memory/long-term.md'), { type: 'file', size: Buffer.byteLength('Original one.\n') });
  assert.equal(await files.stat('missing'), null);
  await assert.rejects(files.stat('../outside'), { code: 'PATH_NOT_ALLOWED' });
  await symlink('memory', join(directory, 'linked-memory'));
  await assert.rejects(files.stat('linked-memory/journal.md'), { code: 'PATH_NOT_ALLOWED' });
});

test('memory-root locks exclude another adapter and release after failure', async (t) => {
  const { directory, files } = await fixture(t);
  const other = createLocalFiles(directory);
  await files.withLock('memory', async () => {
    await assert.rejects(other.withLock('memory', () => assert.fail('Must not enter')), { code: 'RESOURCE_BUSY' });
  });
  await assert.rejects(files.withLock('memory', () => { throw new Error('Interrupted'); }), /Interrupted/);
  assert.equal(await other.withLock('memory', () => 'released'), 'released');
});

test('a lock from a terminated owner can be reclaimed without taking a live lock', async (t) => {
  const { directory, files } = await fixture(t);
  const moduleUrl = new URL('../dist/storage/local-files.js', import.meta.url).href;
  const script = `import { createLocalFiles } from ${JSON.stringify(moduleUrl)}; await createLocalFiles(${JSON.stringify(directory)}).withLock('memory', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fixture child exited ${code}`)));
  });
  assert.ok(await files.read('.dream-locks/memory.json'));
  assert.equal(await files.withLock('memory', () => 'recovered'), 'recovered');
  assert.ok(await files.read('.dream-locks/memory.json'));
  assert.equal((await files.read('.dream-locks/memory.json.1.released')).content,
    (await files.read('.dream-locks/memory.json.1')).content);
});

test('concurrent dead-owner reclaimers never unlink a newly acquired live lock', async (t) => {
  const { directory, files } = await fixture(t);
  const moduleUrl = new URL('../dist/storage/local-files.js', import.meta.url).href;
  const script = `import { createLocalFiles } from ${JSON.stringify(moduleUrl)}; await createLocalFiles(${JSON.stringify(directory)}).withLock('memory', () => process.exit(0));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Fixture child exited ${code}`)));
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let notify;
  const acquired = new Promise((resolve) => { notify = resolve; });
  let entered = 0;
  let rejected = 0;
  let notifyRejected;
  const losersFinished = new Promise((resolve) => { notifyRejected = resolve; });
  const attempts = Array.from({ length: 12 }, () => createLocalFiles(directory).withLock('memory', async () => {
    entered++;
    notify();
    await held;
  }).then(() => null, (error) => { if (++rejected === 11) notifyRejected(); return error; }));
  await acquired;
  await losersFinished;
  try {
    await assert.rejects(createLocalFiles(directory).withLock('memory', () => assert.fail('Live lock stolen')), { code: 'RESOURCE_BUSY' });
    assert.equal(entered, 1);
    assert.ok(await files.read('.dream-locks/memory.json.1'));
  } finally { release(); }
  const results = await Promise.all(attempts);
  assert.equal(results.filter((error) => error === null).length, 1);
  assert.ok(results.filter(Boolean).every((error) => error.code === 'RESOURCE_BUSY'));
  assert.equal(await files.withLock('memory', () => 'next generation'), 'next generation');
});

test('local bounded reads enforce byte limits without truncating evidence', async (t) => {
  const { files } = await fixture(t);
  await files.write('memory/bounded.md', '鱼abc', null);
  assert.equal((await files.read('memory/bounded.md', { maxBytes: 6 })).content, '鱼abc');
  await assert.rejects(files.read('memory/bounded.md', { maxBytes: 5 }), { code: 'FS_TOO_LARGE' });
  await assert.rejects(files.read('memory/bounded.md', { maxBytes: -1 }), TypeError);
  assert.equal(await files.read('missing', { maxBytes: 0 }), null);
});

test('stored jobs keep extra fields and reject unknown record versions', async (t) => {
  const { files, store, job } = await fixture(t);
  await store.saveJob({ ...job, inputFingerprint: 'used-by-the-coordinator' });
  const updated = await store.updateJob('job', (value) => ({ ...value, notification: 'pending' }));
  assert.equal(updated.inputFingerprint, 'used-by-the-coordinator');
  assert.equal((await store.listJobs())[0].notification, 'pending');
  const existing = await files.read('state/jobs/job.json');
  await files.write('state/jobs/job.json', JSON.stringify({ ...job, schemaVersion: 2 }), existing.version);
  await assert.rejects(store.loadJob('job'), /Unsupported stored record version/);
});

test('dreams append by day and deduplicate the same job', async (t) => {
  const { files, store } = await fixture(t);
  const record = { jobId: 'job', date: '2026-10-26', text: 'A synthetic blue fish dreamed of rice.' };
  const path = await store.appendDream(record);
  await store.appendDream(record);
  await store.appendDream({ ...record, jobId: 'another', text: 'A second synthetic dream.' });
  const { content } = await files.read(path);
  assert.equal(content.match(/dream-job:job/g).length, 1);
  assert.match(content, /A second synthetic dream/);
  assert.match(content, /not factual evidence/);
});

test('dream results persist under dreams and a job cannot replace its first generated result', async (t) => {
  const { files, store, job } = await fixture(t);
  const result = { dream: 'A persistent synthetic dream.', proposals: job.proposals, executorThreadId: 1 };
  assert.equal(await store.loadDreamResult('job'), null);
  assert.deepEqual(await store.saveDreamResult('job', result), result);
  assert.deepEqual(await store.saveDreamResult('job', structuredClone(result)), result);
  assert.deepEqual(await store.loadDreamResult('job'), result);
  const envelope = JSON.parse((await files.read('state/dreams/results/job.json')).content);
  assert.deepEqual(envelope, { schemaVersion: 1, jobId: 'job', result });
  await assert.rejects(store.saveDreamResult('job', { ...result, dream: 'Another generated dream.' }), { code: 'RECORD_CONFLICT' });
  await assert.rejects(store.saveDreamResult('job', { ...result, proposals: [] }), { code: 'RECORD_CONFLICT' });
  assert.deepEqual(await store.loadDreamResult('job'), result);
});

test('loading a dream result rejects unknown versions, wrong identities and malformed results', async (t) => {
  const { files, store } = await fixture(t);
  const pathname = 'state/dreams/results/job.json';
  const record = { schemaVersion: 1, jobId: 'job', result: { dream: 'Synthetic dream.', proposals: [] } };
  for (const invalid of [
    { ...record, schemaVersion: 2 },
    { ...record, jobId: 'another-job' },
    { ...record, result: { dream: 1, proposals: [] } },
    { ...record, result: { dream: 'Synthetic dream.', proposals: null } },
  ]) {
    const current = await files.read(pathname);
    await files.write(pathname, JSON.stringify(invalid), current?.version ?? null);
    await assert.rejects(store.loadDreamResult('job'), TypeError);
  }
});

test('rejection records preserve decisions and refuse reusing an id with changed content', async (t) => {
  const { store, job } = await fixture(t);
  const updated = recordReview(job, { proposalId: 'proposal-one', decision: 'reject', reason: 'Insufficient evidence.' },
    scope, { reviewId: 'rejection', now });
  const record = { review: updated.reviews[0], proposal: updated.proposals[0] };
  await store.appendRejected(record);
  await store.appendRejected(record);
  assert.equal((await store.listRejected()).length, 1);
  await assert.rejects(store.appendRejected({ ...record, review: { ...record.review, reason: 'Different reason.' } }), { code: 'RECORD_CONFLICT' });
});

test('partial acceptance commits only its subset, keeps backups and does not replay applied transactions', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f, ['accept', 'defer']);
  const manifest = await f.store.commit(changeSet, f.resolveTarget);
  assert.equal(manifest.status, 'applied');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\n');
  assert.equal((await f.files.read(manifest.entries[0].backup)).content, 'Original one.\n');
  const job = await f.store.loadJob('job');
  assert.deepEqual(job.appliedProposalIds, ['proposal-one']);
  assert.deepEqual(job.committingProposalIds, []);
  assert.deepEqual(job.appliedTransactionIds, ['transaction']);
  const current = await f.files.read('memory/long-term.md');
  await f.files.write('memory/long-term.md', 'Later user edit.', current.version);
  await f.store.commit(changeSet, f.resolveTarget);
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Later user edit.');
});

test('recovery detects a write completed before its progress record', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase, index }) { if (phase === 'written' && index === 0) throw new Error('Crash after write'); },
  }), /Crash after write/);
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\nAccepted one.\n');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\n');
  const recovered = await f.store.recover('transaction');
  assert.equal(recovered.status, 'applied');
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\nAccepted one.\n');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\nAccepted two.\n');
  assert.deepEqual((await f.store.loadJob('job')).appliedProposalIds, ['proposal-one', 'proposal-two']);
});

test('recovery completes the job after the applied manifest was already persisted', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'applied') throw new Error('Crash before job'); },
  }), /Crash before job/);
  assert.deepEqual((await f.store.loadJob('job')).appliedProposalIds, []);
  await f.store.recover('transaction');
  assert.deepEqual((await f.store.loadJob('job')).appliedTransactionIds, ['transaction']);
  await f.store.recover('transaction');
  assert.deepEqual((await f.store.loadJob('job')).appliedTransactionIds, ['transaction']);
});

test('partial recovery refuses external edits and never rolls them back', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase, index }) { if (phase === 'recorded' && index === 0) throw new Error('Crash between files'); },
  }), /Crash between files/);
  const current = await f.files.read('memory/long-term.md');
  await f.files.write('memory/long-term.md', 'User changed the partially committed file.', current.version);
  await assert.rejects(f.store.recover('transaction'), { code: 'FILE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'User changed the partially committed file.');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\n');
});

test('commit rejects evidence changed since the accepted review before touching targets', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  const evidence = await f.files.read('memory/journal.md');
  await f.files.write('memory/journal.md', 'The event was corrected.', evidence.version);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'FILE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
  assert.deepEqual(await f.store.listTransactions(), []);
});

test('recovery rejects evidence changed since the accepted review', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  const evidence = await f.files.read('memory/journal.md');
  await f.files.write('memory/journal.md', 'The event was corrected.', evidence.version);
  await assert.rejects(f.store.recover('transaction'), { code: 'FILE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
});

test('recovery preflights all targets before writing any unchanged file', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  const later = await f.files.read('memory/decisions.md');
  await f.files.write('memory/decisions.md', 'User changed the later target.', later.version);
  await assert.rejects(f.store.recover('transaction'), { code: 'FILE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
});

test('recovery rejects a same-content target with a changed opaque version before any write', async (t) => {
  const f = await fixture(t);
  let changed = false;
  let targetWrites = 0;
  const guarded = {
    ...f.files,
    async read(path) {
      const current = await f.files.read(path);
      return changed && path === 'memory/decisions.md' ? { ...current, version: { revision: 2 } } : current;
    },
    async write(path, content, version) {
      if (path.startsWith('memory/')) targetWrites++;
      return f.files.write(path, content, version);
    },
  };
  f.store = createStore(guarded, { root: 'state', lockKey: 'memory', now: () => now });
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  changed = true;
  await assert.rejects(f.store.recover('transaction'), { code: 'FILE_CONFLICT' });
  assert.equal(targetWrites, 0);
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
  const cancelled = await f.store.cancelUnwritten('transaction', { reason: 'Target version changed' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'Target version changed');
  assert.deepEqual(await f.store.cancelUnwritten('transaction'), cancelled);
  assert.deepEqual((await f.store.listTransactions())[0], cancelled);
  await assert.rejects(f.store.recover('transaction'), { code: 'TRANSACTION_CANCELLED' });
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'TRANSACTION_CANCELLED' });
  assert.deepEqual((await f.store.loadJob('job')).appliedProposalIds, []);
});

test('cancellation refuses potentially written transactions even before a progress record', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.cancelUnwritten('missing'), null);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'written') throw new Error('Crash after write'); },
  }), /Crash after write/);
  const manifest = (await f.store.listTransactions())[0];
  assert.equal(manifest.writeStarted, true);
  assert.equal(manifest.entries[0].done, false);
  await assert.rejects(f.store.cancelUnwritten('transaction'), { code: 'TRANSACTION_NOT_CANCELLABLE' });
  await f.store.recover('transaction');
  await assert.rejects(f.store.cancelUnwritten('transaction'), { code: 'TRANSACTION_NOT_CANCELLABLE' });
});

test('legacy applying manifests cannot be cancelled without a persisted no-write marker', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  const path = 'state/transactions/transaction/manifest.json';
  const record = await f.files.read(path);
  const manifest = JSON.parse(record.content);
  delete manifest.writeStarted;
  manifest.status = 'applying';
  await f.files.write(path, JSON.stringify(manifest), record.version);
  await assert.rejects(f.store.cancelUnwritten('transaction'), { code: 'TRANSACTION_NOT_CANCELLABLE' });
});

test('new transactions cannot bypass review using a forged applied status', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit({ ...changeSet, status: 'applied' }, f.resolveTarget), /must be prepared/);
  await assert.rejects(f.store.commit({ ...changeSet, changes: [{ ...changeSet.changes[0], after: 'Unapproved.' }] }, f.resolveTarget), /approved edits/);
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
});

test('legacy acceptance cannot start a new transaction or replay an existing unwritten manifest', async (t) => {
  const f = await fixture(t);
  const { job, changeSet } = await reviewed(f);
  const legacy = structuredClone(job);
  for (const review of legacy.reviews) delete review.authority;
  await f.store.saveJob(legacy);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'CLEAN_REVIEW_REQUIRED' });
  assert.deepEqual(await f.store.listTransactions(), []);
  await f.store.saveJob(job);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  await f.store.saveJob(legacy);
  const before = await f.files.read('state/transactions/transaction/manifest.json');
  await assert.rejects(f.store.recover('transaction'), { code: 'CLEAN_REVIEW_REQUIRED' });
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), { code: 'CLEAN_REVIEW_REQUIRED' });
  assert.deepEqual(await f.files.read('state/transactions/transaction/manifest.json'), before);
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
  assert.equal((await f.store.cancelUnwritten('transaction')).status, 'cancelled');
});

test('a legacy partially written manifest stops before writing any remaining target', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'written') throw new Error('Crash after write'); },
  }), /Crash after write/);
  await f.store.updateJob('job', job => {
    for (const review of job.reviews) delete review.authority;
    return job;
  });
  await assert.rejects(f.store.recover('transaction'), { code: 'CLEAN_REVIEW_REQUIRED' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\nAccepted one.\n');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\n');
  await assert.rejects(f.store.cancelUnwritten('transaction'), { code: 'TRANSACTION_NOT_CANCELLABLE' });
});

test('already-applied legacy manifests neither replay data nor manufacture clean authority', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'applied') throw new Error('Crash before job'); },
  }), /Crash before job/);
  await f.store.updateJob('job', job => {
    for (const review of job.reviews) delete review.authority;
    return job;
  });
  const current = await f.files.read('memory/long-term.md');
  await f.files.write('memory/long-term.md', 'Later user edit.', current.version);
  await f.store.recover('transaction');
  await f.store.commit(changeSet, f.resolveTarget);
  const job = await f.store.loadJob('job');
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Later user edit.');
  assert.ok(job.reviews.every(review => review.authority === undefined));
  assert.deepEqual(job.appliedTransactionIds, ['transaction']);
});

test('recovery validates frozen clean input even when the job observed partial after-images', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'written') throw new Error('Crash after write'); },
  }), /Crash after write/);
  const current = await f.files.read('memory/long-term.md');
  await f.store.updateJob('job', job => {
    Object.assign(job.snapshot.sources.find(source => source.sourceId === 'one'), current);
    return job;
  });
  assert.equal((await f.store.recover('transaction')).status, 'applied');
  assert.equal((await f.files.read('memory/decisions.md')).content, 'Original two.\nAccepted two.\n');
});

test('manifest recovery cannot drop uncited inputs, replace proposals, or rebase sources', async (t) => {
  const f = await fixture(t);
  const { job, changeSet } = await reviewed(f, ['accept', 'defer']);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  const pathname = 'state/transactions/transaction/manifest.json';
  const original = JSON.parse((await f.files.read(pathname)).content);
  for (const mutate of [
    manifest => { manifest.sources = manifest.sources.filter(source => source.sourceId !== 'two'); },
    manifest => { manifest.sources.find(source => source.sourceId === 'two').version = 'rebased'; },
    manifest => { manifest.sources.find(source => source.sourceId === 'one').path = 'memory/other.md'; },
    manifest => { manifest.changeSet.status = 'applied'; manifest.changeSet.changes[0].after = manifest.entries[0].after = 'Unapproved.'; },
  ]) {
    const manifest = structuredClone(original);
    mutate(manifest);
    const current = await f.files.read(pathname);
    await f.files.write(pathname, JSON.stringify(manifest), current.version);
    await assert.rejects(f.store.recover('transaction'), { code: 'CLEAN_REVIEW_REQUIRED' });
  }
  let current = await f.files.read(pathname);
  await f.files.write(pathname, JSON.stringify(original), current.version);
  for (const mutate of [
    value => { value.proposals[0].reason += ' Rewritten rationale.'; },
    value => { value.snapshot.sources.find(source => source.sourceId === 'two').version = 'rebased'; },
    // Invalidation is now append-only in storage; put it last so the following
    // adversarial case does not implicitly erase the recorded veto.
    value => { value.invalidatedReviewIds = [value.reviews[0].reviewId]; },
  ]) {
    const changed = structuredClone(job);
    mutate(changed);
    await f.store.saveJob(changed);
    await assert.rejects(f.store.recover('transaction'), { code: 'CLEAN_REVIEW_REQUIRED' });
  }
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
});

test('uncited context changes block both fresh commit and recovery', async (t) => {
  const f = await fixture(t);
  const { changeSet } = await reviewed(f, ['accept', 'defer']);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget, {
    afterStep({ phase }) { if (phase === 'prepared') throw new Error('Crash before apply'); },
  }), /Crash before apply/);
  const context = await f.files.read('memory/decisions.md');
  await f.files.write('memory/decisions.md', 'Uncited contradictory context.', context.version);
  await assert.rejects(f.store.commit({ ...changeSet, transactionId: 'fresh-transaction' }, f.resolveTarget), { code: 'FILE_CONFLICT' });
  await assert.rejects(f.store.recover('transaction'), { code: 'FILE_CONFLICT' });
  assert.equal((await f.files.read('memory/long-term.md')).content, 'Original one.\n');
});

test('archiving keeps an explicit copy and recovers a new archive file after interruption', async (t) => {
  const f = await fixture(t);
  f.job.proposals[0] = { ...f.job.proposals[0], operation: 'archive', before: 'Original one.\n', after: '' };
  const { changeSet } = await reviewed(f, ['accept', 'defer']);
  await assert.rejects(f.store.commit(changeSet, f.resolveTarget), /approved edits/);
  changeSet.changes.push({ targetId: 'archive:proposal-one', before: '', after: 'Original one.\n', version: null });
  const archive = 'memory/archive/job-proposal-one.md';
  const resolver = (id) => id === 'archive:proposal-one' ? archive : f.resolveTarget(id);
  await assert.rejects(f.store.commit(changeSet, resolver, {
    afterStep({ phase, index }) { if (phase === 'written' && index === 0) throw new Error('Crash before archive'); },
  }), /Crash before archive/);
  assert.equal(await f.files.read(archive), null);
  const manifest = await f.store.recover('transaction');
  assert.equal((await f.files.read(archive)).content, 'Original one.\n');
  assert.equal((await f.files.read('memory/long-term.md')).content, '');
  assert.equal(manifest.entries[1].existed, false);
  assert.equal(manifest.entries[1].backup, null);
  assert.equal((await f.files.read(manifest.entries[0].backup)).content, 'Original one.\n');
});
