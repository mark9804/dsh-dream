import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleProposals, latestReview, recordReview, reviewMatches, wasRejected } from '../dist/review/index.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';
import { transition } from '../dist/domain/state-machine.js';
import { validateJob, validateReview } from '../dist/domain/contracts.js';

const now = '2026-10-26T08:00:00Z';
function fixture() {
  const scope = { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' };
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: now, sources: [
    { sourceId: 'daily', path: 'daily/today.md', role: 'daily', content: 'Synthetic event. Another event.', version: 1, writable: false, sensitivity: 'private', protectedText: [] },
    { sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: 'Existing memory.\n', version: 1, writable: true, sensitivity: 'private', protectedText: [] },
  ] };
  const proposal = { schemaVersion: 1, proposalId: 'p1', jobId: 'job', kind: 'fact', text: 'Synthetic event.', reason: 'Diary evidence.', evidence: [{ sourceId: 'daily', quote: 'Synthetic event.' }], targetId: 'memory', operation: 'append', before: '', after: 'Synthetic event.\n' };
  return { schemaVersion: 1, jobId: 'job', scope, snapshot, state: 'awaiting_review', proposals: [proposal, { ...structuredClone(proposal), proposalId: 'p2', text: 'Another event.', after: 'Another event.\n' }], reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now };
}
function decide(job, proposalId, decision, reason = 'Checked.') {
  const proposal = job.proposals.find(item => item.proposalId === proposalId);
  const authority = decision === 'accept' && proposal ? syntheticCleanAuthority(job.snapshot, proposal) : undefined;
  return recordReview(job, { proposalId, decision, reason }, { agentId: 'agent', sessionId: 'session' }, { reviewId: `r${job.reviews.length + 1}`, now, authority });
}

test('manual acceptance cannot grant authority and historical accepts remain readable', () => {
  const job = fixture();
  assert.throws(() => recordReview(job, { proposalId: 'p1', decision: 'accept', reason: 'Trust me.' },
    job.scope, { reviewId: 'manual', now }), { code: 'CLEAN_REVIEW_REQUIRED' });
  const legacy = decide(job, 'p1', 'accept');
  delete legacy.reviews[0].authority;
  assert.equal(validateJob(legacy), legacy);
  assert.equal(reviewMatches(legacy, legacy.reviews[0]), false);
  assert.deepEqual(eligibleProposals(legacy), []);
  assert.throws(() => transition(legacy, 'prepared', { now }), /current accepted/);
});

test('clean authority must match the proposal and every uncited source', () => {
  const job = fixture();
  job.snapshot.sources.push({ ...job.snapshot.sources[0], sourceId: 'persona', path: 'AGENTS.md', role: 'persona', content: 'Be careful.' });
  const authority = syntheticCleanAuthority(job.snapshot, job.proposals[0]);
  assert.throws(() => recordReview(job, { proposalId: 'p2', decision: 'accept', reason: 'Wrong input.' },
    job.scope, { reviewId: 'wrong', now, authority }), /digest/);
  const accepted = decide(job, 'p1', 'accept');
  assert.equal(accepted.reviews[0].basis.sources.length, job.snapshot.sources.length);
  for (const mutate of [
    item => { item.snapshot.sources[2].content += ' Updated persona.'; },
    item => { item.snapshot.sources[2].version = 2; },
    item => { item.snapshot.sources.pop(); },
    item => { item.proposals[0].reason += ' New persuasion.'; },
    item => { item.invalidatedReviewIds = [item.reviews[0].reviewId]; },
  ]) {
    const changed = structuredClone(accepted);
    mutate(changed);
    assert.equal(reviewMatches(changed, changed.reviews[0]), false);
    assert.deepEqual(eligibleProposals(changed), []);
  }
});

test('accept can be committed while a deferred sibling remains pending', () => {
  const original = fixture();
  let job = decide(original, 'p1', 'accept');
  job = decide(job, 'p2', 'defer');
  assert.deepEqual(eligibleProposals(job).map((item) => item.proposalId), ['p1']);
  assert.equal(original.reviews.length, 0);
  assert.equal(latestReview(job, 'p2').decision, 'defer');
});

test('the caller must supply the current trusted actor and a valid decision', () => {
  const job = fixture();
  assert.throws(() => recordReview(job, { proposalId: 'p1', decision: 'accept', reason: 'Checked.', reviewer: job.scope }, { agentId: 'other', sessionId: 'session' }, { reviewId: 'r1', now }), /actor/);
  assert.throws(() => decide(job, 'p1', 'approved'), /decision/);
  assert.throws(() => decide(job, 'missing', 'accept'), /unknown proposal/);
});

test('duplicate decisions are no-ops and changed decisions/reasons preserve history', () => {
  const accepted = decide(fixture(), 'p1', 'accept');
  assert.equal(decide(accepted, 'p1', 'accept'), accepted);
  const explained = decide(accepted, 'p1', 'accept', 'Checked again for a different reason.');
  assert.equal(explained.reviews.length, 2);
  const rejected = decide(explained, 'p1', 'reject', 'Evidence does not support the conclusion.');
  assert.equal(rejected.reviews.length, 3);
  assert.equal(eligibleProposals(rejected).length, 0);
  assert.equal(accepted.reviews[0].decision, 'accept');
});

test('proposal, evidence, target and scope changes invalidate old approval', () => {
  const accepted = decide(fixture(), 'p1', 'accept');
  for (const mutate of [
    (job) => { job.proposals[0].after += 'Changed.'; },
    (job) => { job.snapshot.sources[0].content += ' New evidence.'; },
    (job) => { job.snapshot.sources[1].version = 2; },
    (job) => { job.scope.sessionId = 'new-session'; job.snapshot.scope.sessionId = 'new-session'; },
  ]) {
    const modified = structuredClone(accepted);
    mutate(modified);
    assert.equal(eligibleProposals(modified).length, 0);
  }
  const modified = structuredClone(accepted);
  modified.snapshot.sources.push({ ...modified.snapshot.sources[0], sourceId: 'unrelated', path: 'daily/other.md' });
  assert.equal(eligibleProposals(modified).length, 0);
  assert.equal(accepted.reviews[0].proposalSnapshot.after, 'Synthetic event.\n');
});

test('prepared decisions may change; applying freezes only the committing subset', () => {
  let job = decide(fixture(), 'p1', 'accept');
  job = decide(job, 'p2', 'defer');
  const prepared = transition(job, 'prepared', { now, proposalIds: ['p1'] });
  const changed = decide(prepared, 'p1', 'reject');
  assert.equal(changed.state, 'awaiting_review');
  assert.deepEqual(changed.committingProposalIds, []);
  const applying = transition(prepared, 'applying', { now });
  assert.throws(() => decide(applying, 'p1', 'reject'), /committing/);
  assert.equal(decide(applying, 'p2', 'accept').state, 'applying');
});

test('rejected content with identical evidence is not re-proposed under a new id', () => {
  const rejected = decide(fixture(), 'p1', 'reject');
  const proposal = { ...rejected.proposals[0], proposalId: 'different', jobId: 'another-job', text: 'A rephrased summary.', reason: 'Another justification.' };
  assert.equal(wasRejected(proposal, rejected.snapshot, rejected.reviews), true);
  assert.equal(wasRejected({ ...proposal, evidence: [{ sourceId: 'daily', quote: 'Another event.' }] }, rejected.snapshot, rejected.reviews), false);
  const updatedEvidence = structuredClone(rejected.snapshot);
  updatedEvidence.sources[0].version = 2;
  assert.equal(wasRejected(proposal, updatedEvidence, rejected.reviews), true);
  updatedEvidence.sources[1].content += 'An unrelated accepted memory.\n';
  assert.equal(wasRejected(proposal, updatedEvidence, rejected.reviews), true);
});

test('obsolete evidence or target edits can be rejected or deferred but cannot be accepted', () => {
  for (const alter of [
    job => { job.snapshot.sources[0].content = 'The original claim was withdrawn.'; },
    job => { job.snapshot.sources[1].content = 'The target note was rewritten.'; },
    job => { job.snapshot.sources = []; },
  ]) {
    const obsolete = fixture();
    Object.assign(obsolete.proposals[0], { operation: 'replace', before: 'Existing memory.', after: 'Updated memory.' });
    alter(obsolete);
    assert.throws(() => decide(obsolete, 'p1', 'accept'), /evidence|exactly once|unavailable/);
    for (const decision of ['reject', 'defer']) {
      const reviewed = decide(obsolete, 'p1', decision);
      assert.equal(validateJob(reviewed), reviewed);
      assert.deepEqual(eligibleProposals(reviewed), []);
      assert.equal(decide(reviewed, 'p1', decision), reviewed);
      const forgedAccept = { ...latestReview(reviewed, 'p1'), decision: 'accept' };
      assert.throws(() => validateReview(forgedAccept), /evidence|exactly once|referenced/);
    }
  }
});

test('rejecting obsolete proposals can close their exact versions without granting write access', () => {
  const obsolete = fixture();
  obsolete.snapshot.sources[0].content = 'The original claim was withdrawn.';
  let job = decide(decide(obsolete, 'p1', 'reject'), 'p2', 'reject');
  assert.equal(transition(job, 'reviewed_no_changes', { now }).state, 'reviewed_no_changes');
  const changedProposal = structuredClone(job);
  changedProposal.proposals[0].after += 'A different change.';
  assert.throws(() => transition(changedProposal, 'reviewed_no_changes', { now }), /unresolved/);
  job.snapshot.sources[1].version = 2;
  const repeated = decide(job, 'p1', 'reject');
  assert.equal(repeated.reviews.length, job.reviews.length + 1);
});

test('a historical rejection with missing quoted evidence remains readable for suppression', () => {
  const obsolete = fixture();
  obsolete.snapshot.sources[0].content = 'The original claim was withdrawn.';
  const rejected = decide(obsolete, 'p1', 'reject');
  const current = fixture();
  const proposal = { ...current.proposals[0], proposalId: 'new-id', jobId: 'new-job' };
  assert.equal(wasRejected(proposal, current.snapshot, rejected.reviews), true);
  assert.equal(wasRejected({ ...proposal, evidence: [{ sourceId: 'daily', quote: 'Another event.' }] }, current.snapshot, rejected.reviews), false);
});
