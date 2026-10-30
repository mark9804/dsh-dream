import { validateJob } from './contracts.js';
import { eligibleProposals, latestReview, reviewMatches } from '../review/index.js';

import type { Job, State } from '../types.js';
export interface TransitionOptions { now?: string; proposalIds?: string[]; phase?: State; checkpoint?: Job['checkpoint'] }

export const TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(Object.entries({
  queued: ['collecting', 'cancelled', 'failed'],
  collecting: ['generating', 'skipped', 'cancelled', 'failed'],
  generating: ['awaiting_review', 'cancelled', 'failed'],
  awaiting_review: ['prepared', 'completed', 'reviewed_no_changes', 'cancelled', 'failed'],
  prepared: ['awaiting_review', 'applying', 'cancelled', 'failed'],
  applying: ['applied', 'cancelled', 'failed'],
  applied: ['awaiting_compaction', 'cancelled', 'failed'],
  awaiting_compaction: ['compacting', 'awaiting_reload', 'cancelled', 'failed'],
  compacting: ['awaiting_compaction', 'awaiting_reload', 'cancelled', 'failed'],
  awaiting_reload: ['completed', 'awaiting_review', 'cancelled', 'failed'],
  completed: [], skipped: [], reviewed_no_changes: [], failed: [], cancelled: [],
}).map(([state, next]) => [state, Object.freeze(next)])));

export const TERMINAL_STATES = Object.freeze(['completed', 'skipped', 'reviewed_no_changes']);

/** Explicit state changes describe verified work; this function performs no I/O. */
export function transition(job: Job, to: State, { now, proposalIds, phase, checkpoint }: TransitionOptions = {}) {
  validateJob(job);
  const recovering = ['failed', 'cancelled'].includes(job.state);
  if (recovering ? to !== job.checkpoint!.state : !TRANSITIONS[job.state].includes(to)) {
    throw new TypeError(`illegal transition: ${job.state} -> ${to}`);
  }
  if (job.state === 'awaiting_compaction' && to === 'awaiting_reload' && job.compactionChoice?.decision !== 'skip') {
    throw new TypeError('Skipping compaction requires an explicit recorded decision');
  }
  const next = structuredClone(job);
  next.state = to;
  next.updatedAt = now!; // validateJob below rejects a missing timestamp.
  if (to === 'failed' || to === 'cancelled') {
    if (phase !== job.state || checkpoint?.state !== phase) throw new TypeError('failure requires the interrupted phase and matching checkpoint');
    next.phase = phase;
    next.checkpoint = structuredClone(checkpoint);
  } else if (recovering) {
    delete next.phase;
    delete next.checkpoint;
    delete next.error;
  }
  if (to === 'prepared' || (to === 'applying' && !recovering)) {
    const eligible = eligibleProposals(job).map((item) => item.proposalId);
    const selected = proposalIds ?? (to === 'applying' || recovering ? job.committingProposalIds : eligible);
    if (!Array.isArray(selected) || selected.length === 0 || new Set(selected).size !== selected.length || selected.some((id) => !eligible.includes(id))) {
      throw new TypeError('transition requires a nonempty set of current accepted proposals');
    }
    if (to === 'applying' && JSON.stringify(selected) !== JSON.stringify(job.committingProposalIds)) {
      throw new TypeError('applying must use the prepared proposal subset');
    }
    next.committingProposalIds = [...selected];
  }
  if (to === 'applied') {
    if (!job.committingProposalIds?.length) throw new TypeError('applied requires a committing subset');
    next.appliedProposalIds = [...new Set([...job.appliedProposalIds, ...job.committingProposalIds])];
    next.committingProposalIds = [];
  }
  const outstanding = job.proposals.filter((proposal) => !job.appliedProposalIds.includes(proposal.proposalId));
  const allRejected = outstanding.every((proposal) => {
    const review = latestReview(job, proposal.proposalId);
    return review?.decision === 'reject' && reviewMatches(job, review);
  });
  if (to === 'reviewed_no_changes' && (job.appliedProposalIds.length > 0 || !allRejected)) {
    throw new TypeError('reviewed_no_changes requires no applied or unresolved proposals');
  }
  if (to === 'completed' && !allRejected) throw new TypeError('completed cannot discard outstanding proposals');
  if (to === 'completed' && job.state === 'awaiting_review' && job.appliedProposalIds.length === 0) {
    throw new TypeError('unapplied jobs finish as reviewed_no_changes');
  }
  if (to === 'awaiting_review' && job.state === 'prepared') next.committingProposalIds = [];
  if (to === 'skipped' && job.proposals.length > 0) throw new TypeError('skipped cannot discard proposals');
  return validateJob(next);
}
