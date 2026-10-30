import { isDeepStrictEqual } from 'node:util';
import { cleanReviewDigest } from '../review/isolation.js';
import type { Snapshot, Proposal, Review, Job, ChangeSet, Change } from '../types.js';

export type { Scope, Source, Snapshot, Proposal, Review, Job, ChangeSet } from '../types.js';

export const STATES = Object.freeze([
  'queued', 'collecting', 'generating', 'awaiting_review', 'prepared', 'applying',
  'applied', 'awaiting_compaction', 'compacting', 'awaiting_reload', 'completed',
  'failed', 'cancelled', 'skipped', 'reviewed_no_changes',
]);

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}

function text(value: unknown, name: string, empty = false): asserts value is string {
  requireThat(typeof value === 'string' && (empty || value.trim().length > 0), `${name} must be a string${empty ? '' : ' with content'}`);
}

function record(value: unknown, name: string): asserts value is Record<string, unknown> {
  object(value, name);
  requireThat(value.schemaVersion === 1, `${name}: unsupported schemaVersion`);
}

function timestamp(value: unknown, name: string): asserts value is string {
  text(value, name);
  requireThat(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `${name} must be an ISO timestamp with timezone`);
}

function array(value: unknown, name: string): asserts value is unknown[] {
  requireThat(Array.isArray(value), `${name} must be an array`);
}

function unique(values: unknown[], name: string) {
  requireThat(new Set(values).size === values.length, `${name} must be unique`);
}

function ids(values: unknown, name: string): asserts values is string[] {
  array(values, name);
  values.forEach((value) => text(value, name));
  unique(values, name);
}

function json(value: unknown) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  requireThat(value !== null && typeof value === 'object', 'version must be a JSON value');
  requireThat(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, 'version must be a JSON value');
  Object.values(value).forEach(json);
}

function scope(value: unknown) {
  object(value, 'scope');
  for (const key of ['scopeId', 'agentId', 'sessionId', 'memoryRootId']) text(value[key], `scope.${key}`);
}

function source(input: unknown) {
  // Candidate view only: every field is checked below before it becomes trusted.
  const value = input as import('../types.js').Source;
  object(value, 'source');
  for (const key of ['sourceId', 'path'] as const) text(value[key], `source.${key}`);
  requireThat(!value.path.startsWith('/') && !value.path.split('/').includes('..'), 'source.path must stay relative to the memory root');
  requireThat(['daily', 'journal', 'ideas', 'longTerm', 'decisions', 'persona'].includes(value.role), 'source.role is invalid');
  text(value.content, 'source.content', true);
  json(value.version);
  requireThat(typeof value.writable === 'boolean', 'source.writable must be boolean');
  requireThat(['private', 'sensitive'].includes(value.sensitivity), 'source.sensitivity is invalid');
  array(value.protectedText, 'source.protectedText');
  for (const protectedText of value.protectedText) {
    text(protectedText, 'protectedText');
    requireThat(value.content.includes(protectedText), 'protectedText must exist in its source');
  }
}

/** Validate a trusted, explicitly collected snapshot. */
export function validateSnapshot(input: unknown): Snapshot {
  const value = input as Snapshot; // Candidate, validated completely below.
  record(value, 'snapshot');
  text(value.snapshotId, 'snapshotId');
  scope(value.scope);
  timestamp(value.capturedAt, 'capturedAt');
  array(value.sources, 'sources');
  value.sources.forEach(source);
  unique(value.sources.map((item) => item.sourceId), 'sourceIds');
  return value;
}

function proposalRecord(input: unknown): Proposal {
  const value = input as Proposal; // Candidate, validated completely below.
  record(value, 'proposal');
  for (const key of ['proposalId', 'jobId', 'text', 'reason', 'targetId'] as const) text(value[key], `proposal.${key}`);
  requireThat(['fact', 'preference', 'personality', 'commitment', 'feeling'].includes(value.kind), 'proposal.kind is invalid');
  requireThat(['append', 'replace', 'archive'].includes(value.operation), 'proposal.operation is invalid');
  requireThat(!Object.hasOwn(value, 'reviewer') && !Object.hasOwn(value, 'decision'), 'proposal cannot supply review authority');
  text(value.before, 'proposal.before', value.operation === 'append');
  text(value.after, 'proposal.after', value.operation === 'archive');
  if (value.operation === 'append') requireThat(value.before === '', 'append.before must be empty');
  if (value.operation === 'archive') requireThat(value.after === '', 'archive.after must be empty');
  requireThat(value.before !== value.after, 'proposal must change content');
  if (value.kind === 'personality') text(value.impact, 'personality.impact');
  else if (value.impact !== undefined) text(value.impact, 'proposal.impact', true);
  array(value.evidence, 'proposal.evidence');
  requireThat(value.evidence.length > 0, 'proposal requires evidence');
  for (const item of value.evidence) {
    object(item, 'evidence');
    text(item.sourceId, 'evidence.sourceId');
    text(item.quote, 'evidence.quote');
  }
  return value;
}

/** Apply one exact local edit; formatting is supplied by the proposal. */
export function applyProposal(content: string, proposal: Proposal) {
  text(content, 'content', true);
  proposalRecord(proposal);
  if (proposal.operation === 'append') return content + proposal.after;
  const index = content.indexOf(proposal.before);
  requireThat(index !== -1 && content.indexOf(proposal.before, index + 1) === -1, 'proposal.before must match exactly once');
  return content.slice(0, index) + proposal.after + content.slice(index + proposal.before.length);
}

/** Check provenance and deterministic protection rules, not semantic truth. */
export function validateProposal(input: unknown, inputSnapshot: unknown): Proposal {
  const value = proposalRecord(input);
  const snapshot = validateSnapshot(inputSnapshot);
  const target = snapshot.sources.find((item) => item.sourceId === value.targetId);
  requireThat(target?.writable === true, 'proposal target is unavailable or read-only');
  const evidenceSources = value.evidence.map((item) => {
    const evidenceSource = snapshot.sources.find((candidate) => candidate.sourceId === item.sourceId);
    requireThat(evidenceSource?.content.includes(item.quote), 'evidence quote is missing from its source');
    return evidenceSource;
  });
  if (value.kind === 'fact' || value.kind === 'personality') {
    requireThat(evidenceSources.some((item) => ['daily', 'journal'].includes(item!.role)), 'fact/personality requires daily or journal event evidence');
  }
  if (value.kind === 'personality') requireThat(target.role === 'persona', 'personality requires a persona target');
  if (target.role === 'persona') requireThat(value.kind === 'personality', 'persona edits require a personality proposal');
  const result = applyProposal(target.content, value);
  requireThat(target.protectedText.every((item) => result.includes(item)), 'proposal removes protected text');
  return value;
}

/** Historical reviews remain valid records even when their basis becomes stale. */
export function validateReview(input: unknown): Review {
  const value = input as Review; // Candidate, validated completely below.
  record(value, 'review');
  for (const key of ['reviewId', 'proposalId', 'jobId', 'reason'] as const) text(value[key], `review.${key}`);
  timestamp(value.reviewedAt, 'reviewedAt');
  requireThat(['accept', 'reject', 'defer'].includes(value.decision), 'review.decision is invalid');
  object(value.reviewer, 'reviewer');
  text(value.reviewer.agentId, 'reviewer.agentId');
  text(value.reviewer.sessionId, 'reviewer.sessionId');
  proposalRecord(value.proposalSnapshot);
  requireThat(value.proposalId === value.proposalSnapshot.proposalId && value.jobId === value.proposalSnapshot.jobId, 'review proposal identity mismatch');
  object(value.basis, 'review.basis');
  scope(value.basis.scope);
  array(value.basis.sources, 'review.basis.sources');
  value.basis.sources.forEach(source);
  unique(value.basis.sources.map((item) => item.sourceId), 'review sourceIds');
  const snapshot: Snapshot = {
    schemaVersion: 1, snapshotId: value.reviewId, scope: value.basis.scope,
    capturedAt: value.reviewedAt, sources: value.basis.sources,
  };
  if (value.decision === 'accept') {
    const referencedIds = new Set([value.proposalSnapshot.targetId, ...value.proposalSnapshot.evidence.map((item) => item.sourceId)]);
    requireThat([...referencedIds].every(id => value.basis.sources.some(item => item.sourceId === id)), 'review basis must contain the referenced sources and target');
    validateProposal(value.proposalSnapshot, snapshot);
  }
  // A legacy manual acceptance is readable history, never fresh write authority.
  // Completeness against the current job is checked at eligibility/commit time.
  if (value.authority !== undefined) {
    object(value.authority, 'review.authority');
    requireThat(value.authority.kind === 'clean-model' && value.authority.policyVersion === 1, 'review authority kind or policy version is invalid');
    for (const key of ['inputDigest', 'callId', 'provider', 'model'] as const) text(value.authority[key], `review.authority.${key}`);
    requireThat(value.authority.inputDigest === cleanReviewDigest(snapshot, value.proposalSnapshot), 'review authority digest does not match its input');
  }
  requireThat(value.reviewer.agentId === value.basis.scope.agentId && value.reviewer.sessionId === value.basis.scope.sessionId, 'reviewer does not match its scope');
  return value;
}

/** Validate stored records without silently discarding stale review history. */
export function validateJob(input: unknown): Job {
  const value = input as Job; // Candidate, validated below; optional workflow metadata is owned by the engine.
  record(value, 'job');
  text(value.jobId, 'jobId');
  scope(value.scope);
  validateSnapshot(value.snapshot);
  requireThat(isDeepStrictEqual(value.scope, value.snapshot.scope), 'job/snapshot scope mismatch');
  requireThat(STATES.includes(value.state), 'job.state is invalid');
  timestamp(value.createdAt, 'createdAt');
  timestamp(value.updatedAt, 'updatedAt');
  array(value.proposals, 'proposals');
  value.proposals.forEach(proposalRecord);
  unique(value.proposals.map((item) => item.proposalId), 'proposalIds');
  const proposalIds = new Set(value.proposals.map((item) => item.proposalId));
  requireThat(value.proposals.every((item) => item.jobId === value.jobId), 'proposal/job identity mismatch');
  array(value.reviews, 'reviews');
  value.reviews.forEach(validateReview);
  unique(value.reviews.map((item) => item.reviewId), 'reviewIds');
  requireThat(value.reviews.every((item) => item.jobId === value.jobId && proposalIds.has(item.proposalId)), 'review/job identity mismatch');
  ids(value.invalidatedReviewIds ?? [], 'invalidatedReviewIds');
  requireThat((value.invalidatedReviewIds ?? []).every(id => value.reviews.some(review => review.reviewId === id)), 'invalidated review must exist in history');
  ids(value.appliedProposalIds, 'appliedProposalIds');
  ids(value.committingProposalIds ?? [], 'committingProposalIds');
  requireThat([...value.appliedProposalIds, ...(value.committingProposalIds ?? [])].every((id) => proposalIds.has(id)), 'job references an unknown proposal');
  requireThat(!(value.committingProposalIds ?? []).some((id) => value.appliedProposalIds.includes(id)), 'applied proposals cannot be committing');
  if (value.state === 'applying') requireThat(value.committingProposalIds?.length! > 0, 'applying requires a fixed proposal subset');
  if (value.state === 'failed' || value.state === 'cancelled') {
    requireThat(STATES.includes(value.phase!) && !['failed', 'cancelled'].includes(value.phase!), 'failed/cancelled job requires a phase');
    object(value.checkpoint, 'checkpoint');
    requireThat(value.checkpoint.state === value.phase, 'checkpoint must identify the interrupted phase');
  }
  if (value.compactionChoice !== undefined) {
    const choice = value.compactionChoice;
    object(choice, 'compactionChoice');
    requireThat(choice.transactionId === value.transaction?.transactionId && typeof choice.transactionId === 'string', 'compaction choice transaction mismatch');
    requireThat(['compact', 'skip'].includes(choice.decision), 'invalid compaction choice');
    text(choice.reason, 'compaction reason');
    requireThat(choice.reason.length <= 4096, 'compaction reason too long');
    timestamp(choice.at, 'compaction decision time');
    object(choice.actor, 'compaction actor');
    requireThat(choice.actor.agentId === value.scope.agentId && choice.actor.sessionId === value.scope.sessionId, 'compaction actor mismatch');
    object(choice.pressure, 'context pressure');
    for (const key of ['totalTokens', 'contextWindow', 'logRevision'] as const) {
      const number = choice.pressure[key];
      requireThat(number === undefined || (typeof number === 'number' && Number.isFinite(number) && (key === 'contextWindow' ? number > 0 : number >= 0)), 'invalid context pressure');
    }
    requireThat(choice.pressure.baseline === undefined || (typeof choice.pressure.baseline === 'string' && ['none', 'estimated', 'usage'].includes(choice.pressure.baseline)), 'invalid context baseline');
  }
  return value;
}

/** Validate the full-file changes prepared by the storage layer. */
export function validateChangeSet(input: unknown, job?: Job): ChangeSet {
  const value = input as ChangeSet; // Candidate, validated completely below.
  record(value, 'changeSet');
  for (const key of ['transactionId', 'jobId'] as const) text(value[key], `changeSet.${key}`);
  ids(value.proposalIds, 'changeSet.proposalIds');
  ids(value.reviewIds, 'changeSet.reviewIds');
  requireThat(value.proposalIds.length > 0 && value.proposalIds.length === value.reviewIds.length, 'changeSet requires one review per proposal');
  requireThat(['prepared', 'applying', 'applied'].includes(value.status), 'changeSet.status is invalid');
  array(value.changes, 'changeSet.changes');
  requireThat(value.changes.length > 0, 'changeSet requires changes');
  unique(value.changes.map((item) => item.targetId), 'changeSet targetIds');
  for (const change of value.changes) {
    object(change, 'change');
    text(change.targetId, 'change.targetId');
    text(change.before, 'change.before', true);
    text(change.after, 'change.after', true);
    json(change.version);
    requireThat(change.before !== change.after, 'changeSet contains an unchanged target');
  }
  if (job) {
    validateJob(job);
    requireThat(value.jobId === job.jobId, 'changeSet/job identity mismatch');
    if (value.status !== 'applied') {
      requireThat(['prepared', 'applying'].includes(job.state), 'changeSet requires a prepared or applying job');
      requireThat(isDeepStrictEqual(value.proposalIds, job.committingProposalIds), 'changeSet differs from the fixed proposal subset');
    }
    const expected = new Map<string, Change>();
    for (const [index, id] of value.proposalIds.entries()) {
      const proposal = job.proposals.find((item) => item.proposalId === id);
      const review = job.reviews.find((item) => item.reviewId === value.reviewIds[index]);
      requireThat(proposal && review?.proposalId === id && review.decision === 'accept', 'changeSet has no corresponding accept');
      requireThat(isDeepStrictEqual(review.proposalSnapshot, proposal), 'changeSet uses a stale proposal');
      if (value.status === 'applied') continue;
      if (!review.authority) throw Object.assign(new TypeError('changeSet requires clean model acceptance authority'), { code: 'CLEAN_REVIEW_REQUIRED' });
      requireThat(review.authority.inputDigest === cleanReviewDigest(job.snapshot, proposal), 'changeSet uses stale clean model authority');
      requireThat(!(job.invalidatedReviewIds ?? []).includes(review.reviewId), 'changeSet uses invalidated approval');
      requireThat(job.reviews.findLast((item) => item.proposalId === id) === review, 'changeSet uses an outdated review');
      requireThat(!job.appliedProposalIds.includes(id), 'changeSet would apply a proposal twice');
      validateProposal(proposal, job.snapshot);
      requireThat(isDeepStrictEqual(review.basis.scope, job.scope), 'changeSet uses a stale scope');
      requireThat(review.basis.sources.length === job.snapshot.sources.length, 'changeSet requires the full clean review source basis');
      for (const item of review.basis.sources) {
        requireThat(isDeepStrictEqual(job.snapshot.sources.find((candidate) => candidate.sourceId === item.sourceId), item), 'changeSet uses stale evidence or target');
      }
      const target = job.snapshot.sources.find((item) => item.sourceId === proposal.targetId)!; // validateProposal above requires the target.
      const change = expected.get(target.sourceId) ?? { targetId: target.sourceId, before: target.content, after: target.content, version: target.version };
      change.after = applyProposal(change.after, proposal);
      expected.set(target.sourceId, change);
      if (proposal.operation === 'archive') {
        expected.set(`archive:${id}`, { targetId: `archive:${id}`, before: '', after: proposal.before, version: null });
      }
    }
    if (value.status !== 'applied') {
      requireThat(value.changes.length === expected.size && value.changes.every((change) => isDeepStrictEqual(change, expected.get(change.targetId))), 'changeSet content differs from approved edits');
      for (const target of job.snapshot.sources) {
        const change = expected.get(target.sourceId);
        requireThat(!change || target.protectedText.every((item) => change.after.includes(item)), 'combined changes remove protected text');
      }
    }
  }
  return value;
}
