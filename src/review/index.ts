import { isDeepStrictEqual } from 'node:util';
import { assertAdmission, validateJob, validateProposal, validateReview } from '../domain/contracts.js';
import { cleanReviewDigest, reviewPolicyVersion } from './isolation.js';

import type { Proposal, Snapshot, Job, Review, ReviewInput, Actor, CleanReviewAuthority } from '../types.js';

function basis(snapshot: Snapshot) {
  return {
    scope: snapshot.scope,
    ...(snapshot.candidates ? { candidates: snapshot.candidates } : {}),
    ...(snapshot.originalCoverage ? { originalCoverage: snapshot.originalCoverage } : {}),
    // Persona and uncited context are part of the isolated model's input too.
    sources: snapshot.sources.toSorted((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
  };
}

/** Return the newest recorded decision, including one that is now stale. */
export function latestReview(job: Job, proposalId: string) {
  return job.reviews.findLast((item) => item.proposalId === proposalId);
}

/** Host recomputes lineage while refreshing sources; it is not a new editing
 * intent that can reopen an observed rejection. This predicate grants NO writes. */
export function sameVetoProposal(left: Proposal, right: Proposal) {
  const { lineage: _left, ...a } = left, { lineage: _right, ...b } = right;
  return isDeepStrictEqual(a, b);
}
export function hasRejectedProposal(job: Job, proposal: Proposal) {
  return job.reviews.some(review => {
    if (review.jobId !== job.jobId || review.proposalId !== proposal.proposalId || review.decision !== 'reject' || !isDeepStrictEqual(review.basis.scope, job.scope) || !sameVetoProposal(review.proposalSnapshot, proposal)) return false;
    try { validateReview(review); return true; } catch (error) { if (error instanceof TypeError) return false; throw error; }
  });
}

/** Approval needs current provenance; rejecting an obsolete proposal grants no write. */
export function reviewMatches(job: Job, review: Review | undefined) {
  if (!review) return false;
  if (review.decision === 'accept' && (job.invalidatedReviewIds ?? []).includes(review.reviewId)) return false;
  const proposal = job.proposals.find((item) => item.proposalId === review.proposalId);
  if (!proposal || review.jobId !== job.jobId) return false;
  try {
    validateReview(review);
    if (review.decision === 'accept') {
      if (!review.authority || review.authority.policyVersion !== reviewPolicyVersion(job.snapshot, proposal) || review.authority.inputDigest !== cleanReviewDigest(job.snapshot, proposal)) return false;
      validateProposal(proposal, job.snapshot);
      assertAdmission(proposal, job.snapshot);
    }
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return isDeepStrictEqual(review.proposalSnapshot, proposal) &&
    isDeepStrictEqual(review.basis.scope, job.scope) &&
    (review.decision !== 'accept' || isDeepStrictEqual(review.basis, basis(job.snapshot)));
}

/** Return accepted, current, unapplied proposals. A deferred sibling is independent. */
export function eligibleProposals(job: Job) {
  validateJob(job);
  return job.proposals.filter((proposal) => {
    const review = latestReview(job, proposal.proposalId);
    return proposal.operation !== 'retain' && !job.appliedProposalIds.includes(proposal.proposalId) &&
      review?.decision === 'accept' && reviewMatches(job, review);
  });
}

/** Record a decision; only isolated model authority can grant an acceptance. */
export function recordReview(job: Job, input: ReviewInput, actor: Actor,
  { reviewId, now, authority }: { reviewId: string; now: string; authority?: CleanReviewAuthority }) {
  validateJob(job);
  if (!actor || actor.agentId !== job.scope.agentId || actor.sessionId !== job.scope.sessionId) {
    throw new TypeError('review actor does not match the current scope');
  }
  if (!['awaiting_review', 'prepared', 'applying', 'applied', 'awaiting_compaction', 'compacting', 'awaiting_reload'].includes(job.state)) {
    throw new TypeError('job is not open for review');
  }
  const proposal = job.proposals.find((item) => item.proposalId === input.proposalId);
  if (!proposal) throw new TypeError('unknown proposal');
  if (input.decision === 'accept') {
    if (!authority || authority.policyVersion !== reviewPolicyVersion(job.snapshot, proposal)) throw Object.assign(new TypeError('Acceptance requires matching clean model authority'), { code: 'CLEAN_REVIEW_REQUIRED' });
    validateProposal(proposal, job.snapshot);
    assertAdmission(proposal, job.snapshot);
  }
  const review: Review = {
    schemaVersion: 1, reviewId, proposalId: proposal.proposalId, jobId: job.jobId,
    reviewer: { agentId: actor.agentId, sessionId: actor.sessionId },
    decision: input.decision, reason: input.reason, reviewedAt: now,
    proposalSnapshot: structuredClone(proposal), basis: structuredClone(basis(job.snapshot)),
    ...(authority ? { authority: structuredClone(authority) } : {}),
  };
  validateReview(review);
  const previous = latestReview(job, proposal.proposalId);
  if (previous?.decision === review.decision && previous.reason === review.reason &&
    isDeepStrictEqual(previous.basis, review.basis) && reviewMatches(job, previous)) return job;
  if (job.reviews.some((item) => item.reviewId === reviewId)) throw new TypeError('reviewId is already in use');
  if (job.appliedProposalIds.includes(proposal.proposalId) || (job.state === 'applying' && (job.committingProposalIds ?? []).includes(proposal.proposalId))) {
    throw new TypeError('cannot change a committed or committing decision');
  }
  const next = structuredClone(job);
  next.reviews.push(review);
  next.updatedAt = now;
  if (next.state === 'prepared') {
    next.state = 'awaiting_review';
    next.committingProposalIds = [];
  }
  return validateJob(next);
}

function rejectionContent(proposal: Proposal) {
  return {
    kind: proposal.kind, targetId: proposal.targetId, operation: proposal.operation,
    before: proposal.before, after: proposal.after,
    evidence: proposal.evidence.toSorted((a, b) => `${a.sourceId}\n${a.quote}`.localeCompare(`${b.sourceId}\n${b.quote}`)),
  };
}

/** Suppress unchanged rejected edits; unrelated source changes do not reopen them. */
export function wasRejected(proposal: Proposal, snapshot: Snapshot, reviews: Review[]) {
  validateProposal(proposal, snapshot);
  return reviews.some((review) => {
    validateReview(review);
    return review.decision === 'reject' &&
      isDeepStrictEqual(review.basis.scope, snapshot.scope) &&
      isDeepStrictEqual(rejectionContent(review.proposalSnapshot), rejectionContent(proposal));
  });
}
