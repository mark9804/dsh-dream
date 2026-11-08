import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProposal, validateChangeSet, validateJob, validateProposal, validateReview, validateSnapshot } from '../dist/domain/contracts.js';
import { recordReview } from '../dist/review/index.js';
import { transition } from '../dist/domain/state-machine.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';

const now = '2026-10-26T08:00:00Z';
function fixture() {
  const scope = { scopeId: 'scope', agentId: 'agent', sessionId: 'session', memoryRootId: 'memory' };
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: now, sources: [
    { sourceId: 'daily', path: 'daily/26-10-26.md', role: 'daily', content: 'We completed the synthetic experiment.', version: 1, writable: false, sensitivity: 'private', protectedText: [] },
    { sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: 'Pinned name.\nOld note.\n', version: { revision: 1 }, writable: true, sensitivity: 'private', protectedText: ['Pinned name.'] },
    { sourceId: 'persona', path: 'AGENTS.md', role: 'persona', content: 'Be concise.\n', version: 1, writable: true, sensitivity: 'private', protectedText: [] },
  ] };
  const proposal = { schemaVersion: 1, proposalId: 'proposal', jobId: 'job', kind: 'fact', text: 'The experiment is complete.', reason: 'The diary records it.', evidence: [{ sourceId: 'daily', quote: 'completed the synthetic experiment' }], targetId: 'memory', operation: 'append', before: '', after: 'The experiment is complete.\n' };
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, state: 'awaiting_review', proposals: [proposal], reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now };
  return { snapshot, proposal, job, actor: { agentId: 'agent', sessionId: 'session' } };
}

function prepared(operation = 'append') {
  const { job, proposal, actor } = fixture();
  if (operation === 'archive') Object.assign(proposal, { operation, before: 'Old note.\n', after: '' });
  const reviewed = recordReview(job, { proposalId: proposal.proposalId, decision: 'accept', reason: 'Checked the evidence.' }, actor, { reviewId: 'review', now, authority: syntheticCleanAuthority(job.snapshot, proposal) });
  const ready = transition(reviewed, 'prepared', { now });
  const target = job.snapshot.sources[1];
  const changes = [{ targetId: 'memory', before: target.content, after: applyProposal(target.content, proposal), version: target.version }];
  if (operation === 'archive') changes.push({ targetId: 'archive:proposal', before: '', after: proposal.before, version: null });
  return { job: ready, changeSet: { schemaVersion: 1, transactionId: 'transaction', jobId: 'job', proposalIds: ['proposal'], reviewIds: ['review'], status: 'prepared', changes } };
}

test('versioned records validate and unknown schema versions are rejected', () => {
  const { snapshot, proposal, job } = fixture();
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.equal(validateProposal(proposal, snapshot), proposal);
  assert.equal(validateJob(job), job);
  for (const [value, validate] of [[snapshot, validateSnapshot], [proposal, (item) => validateProposal(item, snapshot)], [job, validateJob]]) {
    assert.throws(() => validate({ ...value, schemaVersion: 2 }), /schemaVersion/);
  }
  const preparedJob = prepared();
  assert.throws(() => validateReview({ ...preparedJob.job.reviews[0], schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => validateChangeSet({ ...preparedJob.changeSet, schemaVersion: 2 }), /schemaVersion/);
});

test('quotes must refer to real original sources and facts require an event source', () => {
  const { proposal, snapshot } = fixture();
  assert.throws(() => validateProposal({ ...proposal, evidence: [{ sourceId: 'missing', quote: 'event' }] }, snapshot), /evidence/);
  assert.throws(() => validateProposal({ ...proposal, evidence: [{ sourceId: 'daily', quote: 'made up event' }] }, snapshot), /evidence/);
  assert.throws(() => validateProposal({ ...proposal, evidence: [{ sourceId: 'memory', quote: 'Old note.' }] }, snapshot), /daily or journal/);
  snapshot.sources[0].role = 'dream';
  assert.throws(() => validateSnapshot(snapshot), /source.role/);
});

test('targets are writable logical sources and sources stay within the memory root', () => {
  const { proposal, snapshot } = fixture();
  assert.throws(() => validateProposal({ ...proposal, targetId: 'daily' }, snapshot), /read-only/);
  assert.throws(() => validateProposal({ ...proposal, targetId: '/etc/passwd' }, snapshot), /unavailable/);
  snapshot.sources[0].path = '../private.md';
  assert.throws(() => validateSnapshot(snapshot), /relative/);
});

test('local edits preserve pinned text and match their before text exactly once', () => {
  const { proposal, snapshot } = fixture();
  const edit = { ...proposal, operation: 'replace', before: 'Old note.', after: 'Updated note.' };
  assert.equal(validateProposal(edit, snapshot), edit);
  assert.equal(applyProposal('Old note.', edit), 'Updated note.');
  assert.throws(() => applyProposal('Old note. Old note.', edit), /exactly once/);
  assert.throws(() => validateProposal({ ...edit, before: 'Missing note.' }, snapshot), /exactly once/);
  assert.throws(() => validateProposal({ ...edit, before: 'Pinned name.' }, snapshot), /protected/);
  assert.throws(() => validateProposal({ ...proposal, operation: 'archive', before: 'Pinned name.', after: '' }, snapshot), /protected/);
});

test('personality requires a persona target, impact and event evidence; feelings are explicit', () => {
  const { proposal, snapshot } = fixture();
  const personality = { ...proposal, kind: 'personality', targetId: 'persona', impact: 'Respond more directly.' };
  assert.equal(validateProposal(personality, snapshot), personality);
  assert.throws(() => validateProposal({ ...personality, impact: '' }, snapshot), /impact/);
  assert.throws(() => validateProposal({ ...personality, targetId: 'memory' }, snapshot), /persona target/);
  assert.throws(() => validateProposal({ ...proposal, targetId: 'persona' }, snapshot), /personality proposal/);
  assert.equal(validateProposal({ ...proposal, kind: 'feeling' }, snapshot).kind, 'feeling');
  assert.throws(() => validateProposal({ ...proposal, reviewer: 'agent', decision: 'accept' }, snapshot), /authority/);
});

test('a change set contains only the exact approved edits and fixed proposal subset', () => {
  const { job, changeSet } = prepared();
  assert.equal(validateChangeSet(changeSet, job), changeSet);
  const tampered = structuredClone(changeSet);
  tampered.changes[0].after += 'Unapproved addition.';
  assert.throws(() => validateChangeSet(tampered, job), /approved edits/);
  assert.throws(() => validateChangeSet({ ...changeSet, reviewIds: ['unknown'] }, job), /accept/);
  assert.throws(() => validateChangeSet(changeSet, { ...job, committingProposalIds: [] }), /fixed proposal subset/);
  const missingBasis = structuredClone(job.reviews[0]);
  missingBasis.basis.sources = [];
  assert.throws(() => validateReview(missingBasis), /contain the referenced/);
});

test('clean review records validate route and complete digest while legacy accepts stay readable', () => {
  const { job, changeSet } = prepared();
  const review = job.reviews[0];
  assert.equal(validateReview(review), review);
  for (const overrides of [
    { kind: 'manual' }, { policyVersion: 2 }, { inputDigest: 'wrong' },
    { callId: '' }, { provider: ' ' }, { model: 123 },
  ]) {
    assert.throws(() => validateReview({ ...review, authority: { ...review.authority, ...overrides } }), /authority/);
  }
  const legacy = structuredClone(job);
  delete legacy.reviews[0].authority;
  legacy.reviews[0].basis.sources = legacy.reviews[0].basis.sources.filter(source => source.sourceId !== 'persona');
  assert.equal(validateJob(legacy), legacy);
  assert.throws(() => validateChangeSet(changeSet, legacy), { code: 'CLEAN_REVIEW_REQUIRED' });
  assert.equal(validateChangeSet({ ...changeSet, status: 'applied' }, legacy).status, 'applied');
});

test('omitted persona cannot be authorized even by a self-consistent subset digest', () => {
  const { job, changeSet } = prepared();
  const review = job.reviews[0];
  review.basis.sources = review.basis.sources.filter(source => source.sourceId !== 'persona');
  review.authority = syntheticCleanAuthority({ ...job.snapshot, sources: review.basis.sources }, review.proposalSnapshot);
  assert.equal(validateReview(review), review);
  assert.throws(() => validateChangeSet(changeSet, job), /stale clean model authority|full clean review/);
});

test('digest excludes persuasion but changeset matching still binds the full proposal', () => {
  const { job, changeSet } = prepared();
  job.proposals[0].reason += ' Changed generator reasoning.';
  assert.equal(syntheticCleanAuthority(job.snapshot, job.proposals[0]).inputDigest, job.reviews[0].authority.inputDigest);
  assert.throws(() => validateChangeSet(changeSet, job), /stale proposal/);
});

test('archiving requires an exact preserved copy as well as removing the old entry', () => {
  const { job, changeSet } = prepared('archive');
  assert.equal(validateChangeSet(changeSet, job), changeSet);
  assert.throws(() => validateChangeSet({ ...changeSet, changes: changeSet.changes.slice(0, 1) }, job), /approved edits/);
  const tampered = structuredClone(changeSet);
  tampered.changes[1].after = 'Lost original';
  assert.throws(() => validateChangeSet(tampered, job), /approved edits/);
});

test('combined individually valid edits cannot remove the last protected text', () => {
  const { job, proposal, actor } = fixture();
  const target = job.snapshot.sources[1];
  target.content = 'Pinned first. Pinned second.';
  target.protectedText = ['Pinned'];
  Object.assign(proposal, { operation: 'replace', before: 'Pinned first.', after: 'First.' });
  job.proposals.push({ ...structuredClone(proposal), proposalId: 'second', before: 'Pinned second.', after: 'Second.' });
  let reviewed = recordReview(job, { proposalId: 'proposal', decision: 'accept', reason: 'Checked.' }, actor, { reviewId: 'r1', now, authority: syntheticCleanAuthority(job.snapshot, proposal) });
  reviewed = recordReview(reviewed, { proposalId: 'second', decision: 'accept', reason: 'Checked.' }, actor,
    { reviewId: 'r2', now, authority: syntheticCleanAuthority(reviewed.snapshot, reviewed.proposals[1]) });
  const ready = transition(reviewed, 'prepared', { now });
  const changeSet = { schemaVersion: 1, transactionId: 'transaction', jobId: 'job', proposalIds: ['proposal', 'second'], reviewIds: ['r1', 'r2'], status: 'prepared', changes: [{ targetId: 'memory', before: target.content, after: 'First. Second.', version: target.version }] };
  assert.throws(() => validateChangeSet(changeSet, ready), /combined changes remove protected/);
});
