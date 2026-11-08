import assert from 'node:assert/strict';
import test from 'node:test';
import { TERMINAL_STATES, transition } from '../dist/domain/state-machine.js';
import { recordReview } from '../dist/review/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const now = '2026-10-26T08:00:00Z';
function fixture(state = 'awaiting_review') {
  const scope = { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' };
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: now, sources: [
    { sourceId: 'daily', path: 'daily/today.md', role: 'daily', content: 'Synthetic event.', version: 1, writable: false, sensitivity: 'private', protectedText: [] },
    { sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: 'Old note.\n', version: 1, writable: true, sensitivity: 'private', protectedText: [] },
  ] };
  const proposal = { schemaVersion: 1, proposalId: 'p1', jobId: 'job', kind: 'fact', text: 'Synthetic event.', reason: 'Diary evidence.', evidence: [{ sourceId: 'daily', quote: 'Synthetic event.' }], targetId: 'memory', operation: 'append', before: '', after: 'Synthetic event.\n' };
  return { schemaVersion: 1, jobId: 'job', scope, snapshot, state, proposals: [proposal, { ...structuredClone(proposal), proposalId: 'p2', after: 'Second event.\n' }], reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now };
}
function decide(job, id, decision) {
  return recordReview(job, { proposalId: id, decision, reason: 'Checked.' }, { agentId: 'agent', sessionId: 'session' }, {
    reviewId: `r${job.reviews.length + 1}`, now,
    ...(decision === 'accept' ? { authority: syntheticCleanAuthority(job.snapshot, job.proposals.find(proposal => proposal.proposalId === id)) } : {}),
  });
}
function acceptedJob() {
  return decide(decide(fixture(), 'p1', 'accept'), 'p2', 'defer');
}

test('illegal transitions cannot skip review, submission or unresolved proposals', () => {
  assert.throws(() => transition(fixture('queued'), 'applied', { now }), /illegal transition/);
  assert.throws(() => transition(fixture(), 'prepared', { now }), /accepted proposals/);
  assert.throws(() => transition(fixture(), 'reviewed_no_changes', { now }), /unresolved/);
  assert.throws(() => transition(fixture('awaiting_reload'), 'completed', { now }), /outstanding/);
});

test('a partial commit fixes its subset and returns to review for remaining proposals', () => {
  let job = transition(acceptedJob(), 'prepared', { now });
  assert.deepEqual(job.committingProposalIds, ['p1']);
  job = transition(job, 'applying', { now });
  job = transition(job, 'applied', { now });
  assert.deepEqual(job.appliedProposalIds, ['p1']);
  assert.deepEqual(job.committingProposalIds, []);
  for (const state of ['awaiting_compaction', 'compacting', 'awaiting_reload', 'awaiting_review']) job = transition(job, state, { now });
  assert.equal(job.state, 'awaiting_review');
  job = decide(job, 'p2', 'reject');
  job = transition(job, 'completed', { now });
  assert.equal(job.state, 'completed');
  assert.throws(() => transition(job, 'queued', { now }), /illegal transition/);
});

test('all rejected proposals finish without pretending memory was applied', () => {
  const rejected = decide(decide(fixture(), 'p1', 'reject'), 'p2', 'reject');
  const complete = transition(rejected, 'reviewed_no_changes', { now });
  assert.equal(complete.state, 'reviewed_no_changes');
  assert.deepEqual(complete.appliedProposalIds, []);
  assert.ok(TERMINAL_STATES.includes(complete.state));
  assert.throws(() => transition(complete, 'prepared', { now }), /illegal transition/);
});

test('historical rejection with refreshed Host lineage still permits both non-write and post-ACK terminal transitions', () => {
  const rejected = decide(decide(fixture(), 'p1', 'reject'), 'p2', 'reject');
  rejected.reviews[0].proposalSnapshot.lineage = { policyVersion: 1, rootIds: ['fresh-original-root'], derivedFrom: [], independentEvents: 'unknown' };
  assert.equal(transition(rejected, 'reviewed_no_changes', { now }).state, 'reviewed_no_changes');
  let applied = decide(decide(fixture(), 'p1', 'reject'), 'p2', 'accept');
  applied.reviews[0].proposalSnapshot.lineage = structuredClone(rejected.reviews[0].proposalSnapshot.lineage);
  for (const state of ['prepared', 'applying', 'applied', 'awaiting_compaction', 'compacting', 'awaiting_reload']) applied = transition(applied, state, { now });
  assert.equal(transition(applied, 'completed', { now }).state, 'completed');
  const changed = structuredClone(rejected); changed.proposals[0].after = 'A different edit.\n';
  assert.throws(() => transition(changed, 'reviewed_no_changes', { now }), /unresolved/);
});

test('failure and cancellation resume only their recorded phase, preserving a committing subset', () => {
  const applying = transition(transition(acceptedJob(), 'prepared', { now }), 'applying', { now });
  assert.throws(() => transition(applying, 'failed', { now }), /checkpoint/);
  for (const state of ['failed', 'cancelled']) {
    const failed = transition(applying, state, { now, phase: 'applying', checkpoint: { state: 'applying', transactionId: 'transaction' } });
    assert.throws(() => transition(failed, 'queued', { now }), /illegal transition/);
    const recovered = transition(failed, 'applying', { now });
    assert.deepEqual(recovered.committingProposalIds, ['p1']);
    assert.equal(recovered.checkpoint, undefined);
  }
  const bothAccepted = decide(acceptedJob(), 'p2', 'accept');
  const subset = transition(bothAccepted, 'prepared', { now, proposalIds: ['p1'] });
  const failed = transition(subset, 'failed', { now, phase: 'prepared', checkpoint: { state: 'prepared' } });
  assert.deepEqual(transition(failed, 'prepared', { now }).committingProposalIds, ['p1']);
});

test('only a truly empty collecting job can be skipped', () => {
  assert.throws(() => transition(fixture('collecting'), 'skipped', { now }), /discard proposals/);
  const empty = { ...fixture('collecting'), proposals: [] };
  assert.equal(transition(empty, 'skipped', { now }).state, 'skipped');
});
