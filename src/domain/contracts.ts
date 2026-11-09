import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { cleanReviewDigest, reviewPolicyVersion } from '../review/isolation.js';
import { proposalLineage } from '../dream/lineage.js';
import { requireOriginalEvidence } from '../dream/originals.js';
import { validateGenerationDiagnostics } from './generation-diagnostics.js';
import { validateGenerationAttemptDetails } from './generation-attempt.js';
import type { Snapshot, Proposal, Review, Job, ChangeSet, Change, AcknowledgedTransaction } from '../types.js';

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
  if (value.provenance !== undefined) {
    const p = value.provenance;
    record(p, 'source.provenance');
    requireThat(['file-artifact', 'derived', 'mixed'].includes(p.kind), 'provenance kind is invalid');
    text(p.artifactId, 'artifactId');
    requireThat(p.contentHash === createHash('sha256').update(value.content).digest('hex'), 'provenance content hash is stale');
    ids(p.rootIds, 'provenance.rootIds'); ids(p.derivedFrom, 'provenance.derivedFrom');
    requireThat(p.independentEvents === 'unknown', 'file provenance cannot assert independent events');
    if (p.spans !== undefined) {
      array(p.spans, 'provenance.spans');
      requireThat(p.spans.map(span => span.text).join('') === value.content, 'provenance spans must partition the complete source');
      for (const span of p.spans) {
        text(span.text, 'provenance.span.text', true);
        requireThat(span.text.length > 0, 'provenance span cannot be empty');
        requireThat(value.content.includes(span.text), 'derived span must exist in source');
        ids(span.rootIds, 'span.rootIds'); ids(span.derivedFrom, 'span.derivedFrom');
      }
    }
  }
  if (value.originals !== undefined) {
    array(value.originals, 'source.originals');
    for (const receipt of value.originals) {
      record(receipt, 'original receipt');
      requireThat(['verified', 'unavailable', 'invalid'].includes(receipt.status), 'original receipt status invalid');
      requireThat(receipt.independentEvents === 'unknown', 'original message occurrence is not an independent event');
      object(receipt.ref, 'original ref');
      text(receipt.ref.sessionId, 'original session'); text(receipt.ref.quote, 'original quote', receipt.status !== 'verified');
      requireThat(Number.isSafeInteger(receipt.ref.seq) && receipt.ref.seq >= 0 && Number.isSafeInteger(receipt.ref.blockIndex) && receipt.ref.blockIndex >= 0, 'original position invalid');
      if (receipt.status === 'verified') {
        requireThat(value.content.includes(receipt.ref.quote), 'verified quote absent from source');
        object(receipt.canonical, 'canonical original');
        requireThat(receipt.canonical.sessionId === receipt.ref.sessionId && receipt.canonical.seq === receipt.ref.seq, 'canonical identity mismatch');
        for (const k of ['messageId', 'sourceKind', 'eventHash'] as const) text(receipt.canonical[k], `canonical.${k}`);
        requireThat(['user', 'assistant', 'tool'].includes(receipt.canonical.role), 'original role invalid');
      }
    }
  }
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
  if (value.originalCoverage !== undefined) { object(value.originalCoverage, 'originalCoverage'); ids(value.originalCoverage.uncollectedSourceIds, 'uncollectedSourceIds'); }
  if (value.candidates !== undefined) {
    object(value.candidates, 'snapshot.candidates');
    array(value.candidates.items, 'candidates.items');
    requireThat(Number.isSafeInteger(value.candidates.total) && value.candidates.total >= value.candidates.items.length, 'candidate total is invalid');
    requireThat(value.candidates.truncated === (value.candidates.total > value.candidates.items.length), 'candidate truncation is invalid');
    unique(value.candidates.items.map(c => c.candidateId), 'candidate IDs');
    for (const c of value.candidates.items) {
      for (const k of ['candidateId', 'claimKey', 'text'] as const) text(c[k], `candidate.${k}`);
      applicability(c.applicability);
      ids(c.proposalIds, 'candidate.proposalIds'); ids(c.rootIds, 'candidate.rootIds');
      requireThat(c.independentEvents === 'unknown', 'candidate cannot assert independent events');
      requireThat(['pending', 'retained', 'active', 'rejected'].includes(c.status), 'candidate status invalid');
    }
  }
  return value;
}

function applicability(input: unknown) {
  object(input, 'applicability');
  requireThat(Object.keys(input).every(k => ['topic', 'conditions', 'validFrom', 'validUntil'].includes(k)), 'unexpected applicability field');
  text(input.topic, 'applicability.topic'); text(input.conditions, 'applicability.conditions');
  if (input.validFrom !== undefined) timestamp(input.validFrom, 'validFrom');
  if (input.validUntil !== undefined) timestamp(input.validUntil, 'validUntil');
  if (input.validFrom && input.validUntil) requireThat(Date.parse(String(input.validFrom)) <= Date.parse(String(input.validUntil)), 'applicability time interval is inverted');
}

function proposalRecord(input: unknown): Proposal {
  const value = input as Proposal; // Candidate, validated completely below.
  record(value, 'proposal');
  for (const key of ['proposalId', 'jobId', 'text', 'reason', 'targetId'] as const) text(value[key], `proposal.${key}`);
  requireThat(['fact', 'preference', 'personality', 'commitment', 'feeling'].includes(value.kind), 'proposal.kind is invalid');
  requireThat(['append', 'replace', 'archive', 'retain'].includes(value.operation), 'proposal.operation is invalid');
  requireThat(!Object.hasOwn(value, 'reviewer') && !Object.hasOwn(value, 'decision'), 'proposal cannot supply review authority');
  text(value.before, 'proposal.before', value.operation === 'append');
  text(value.after, 'proposal.after', value.operation === 'archive');
  if (value.operation === 'append') requireThat(value.before === '', 'append.before must be empty');
  if (value.operation === 'archive') requireThat(value.after === '', 'archive.after must be empty');
  requireThat(value.operation === 'retain' ? value.before === value.after : value.before !== value.after, 'proposal must change content unless retaining an exact fragment');
  if (value.consolidation !== undefined) {
    const c = value.consolidation;
    object(c, 'consolidation');
    requireThat(Object.keys(c).every(k => ['action', 'claimKey', 'applicability', 'basis', 'candidateId'].includes(k)), 'unexpected consolidation field');
    requireThat(['add', 'keep', 'reinforce', 'merge', 'correct', 'promote', 'needs-verification'].includes(c.action), 'consolidation.action invalid');
    requireThat(['explicit', 'observation', 'correction', 'recurrence', 'uncertain'].includes(c.basis), 'consolidation.basis invalid');
    text(c.claimKey, 'claimKey'); applicability(c.applicability);
    if (c.candidateId !== undefined) text(c.candidateId, 'candidateId');
    if (['keep', 'reinforce', 'needs-verification'].includes(c.action)) requireThat(value.operation === 'retain', 'keep/reinforce/needs-verification requires retain');
    if (c.action === 'add') requireThat(value.operation === 'append', 'add requires append');
    if (['merge', 'correct'].includes(c.action)) requireThat(value.operation === 'replace', 'merge/correct requires replace');
    if (c.action === 'promote') requireThat(['append', 'replace'].includes(value.operation) && !!c.candidateId, 'promote requires a candidate and text change');
  }
  if (value.operation === 'retain') requireThat(!!value.consolidation && ['keep', 'reinforce', 'needs-verification'].includes(value.consolidation.action), 'retain requires a metadata decision');
  if (value.lineage !== undefined) {
    object(value.lineage, 'proposal.lineage');
    requireThat(value.lineage.policyVersion === 1 && value.lineage.independentEvents === 'unknown', 'lineage policy or independence invalid');
    ids(value.lineage.rootIds, 'lineage.rootIds'); ids(value.lineage.derivedFrom, 'lineage.derivedFrom');
  }
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

/** No artifact-count rule can assert independently observed recurrence. */
export function assertAdmission(proposal: Proposal, snapshot: Snapshot) {
  requireOriginalEvidence(snapshot, proposal.evidence);
  if (proposal.lineage && !isDeepStrictEqual(proposal.lineage, proposalLineage(proposal, snapshot))) throw new TypeError('proposal lineage differs from current evidence');
  if (proposal.operation !== 'retain' && proposal.consolidation && ['uncertain', 'recurrence'].includes(proposal.consolidation.basis)) {
    throw Object.assign(new TypeError('Unknown independence or uncertain support must remain a candidate, not a writable acceptance'), { code: 'NEEDS_VERIFICATION' });
  }
}

/** Check provenance and deterministic protection rules, not semantic truth. */
export function validateProposal(input: unknown, inputSnapshot: unknown): Proposal {
  const value = proposalRecord(input);
  const snapshot = validateSnapshot(inputSnapshot);
  const target = snapshot.sources.find((item) => item.sourceId === value.targetId);
  requireThat(!!target && (target.writable || value.operation === 'retain'), 'proposal target is unavailable or read-only');
  if (value.consolidation?.candidateId) {
    const candidate = snapshot.candidates?.items.find(c => c.candidateId === value.consolidation!.candidateId);
    requireThat(!!candidate && candidate.claimKey === value.consolidation.claimKey && isDeepStrictEqual(candidate.applicability, value.consolidation.applicability), 'candidate must be in the reviewed view with matching scope');
    requireThat(candidate.status !== 'rejected', 'rejected candidate cannot be promoted or revived');
  }
  const evidenceSources = value.evidence.map((item) => {
    const evidenceSource = snapshot.sources.find((candidate) => candidate.sourceId === item.sourceId);
    requireThat(evidenceSource?.content.includes(item.quote), 'evidence quote is missing from its source');
    return evidenceSource;
  });
  if (value.operation !== 'retain' && (value.kind === 'fact' || value.kind === 'personality')) {
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
    capturedAt: value.reviewedAt, sources: value.basis.sources, ...(value.basis.candidates ? { candidates: value.basis.candidates } : {}), ...(value.basis.originalCoverage ? { originalCoverage: value.basis.originalCoverage } : {}),
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
    requireThat(value.authority.kind === 'clean-model' && [1, 2, 3].includes(value.authority.policyVersion), 'review authority kind or policy version is invalid');
    for (const key of ['inputDigest', 'callId', 'provider', 'model'] as const) text(value.authority[key], `review.authority.${key}`);
    requireThat(value.authority.inputDigest === cleanReviewDigest(snapshot, value.proposalSnapshot, value.authority.policyVersion), 'review authority digest does not match its input');
  }
  requireThat(value.reviewer.agentId === value.basis.scope.agentId && value.reviewer.sessionId === value.basis.scope.sessionId, 'reviewer does not match its scope');
  return value;
}

function reloadSources(value: unknown, name: string): asserts value is import('../types.js').ReloadSource[] {
  array(value, name);
  for (const source of value) {
    object(source, `${name} source`);
    requireThat(Object.keys(source).every(key => ['sourceId', 'path', 'version', 'content'].includes(key)), `unexpected ${name} source field`);
    text(source.sourceId, `${name} sourceId`);
    text(source.path, `${name} path`);
    text(source.content, `${name} content`, true);
    json(source.version);
  }
  const sources = value as import('../types.js').ReloadSource[]; // Every member validated above.
  unique(sources.map(source => source.sourceId), `${name} sourceIds`);
  unique(sources.map(source => source.path), `${name} paths`);
}

function writtenSources(value: unknown, transaction: ChangeSet): asserts value is import('../types.js').ReloadSource[] {
  reloadSources(value, 'transaction written sources');
  requireThat(value.length === transaction.changes.length && transaction.changes.every(change => value.some(source => source.sourceId === change.targetId && source.content === change.after && source.version !== null)), 'transaction written sources must match every changed after-image');
}

/** Historical acknowledgement structure, not authorization to apply any edit again. */
function acknowledgedTransaction(input: unknown, job: Job): AcknowledgedTransaction {
  const value = input as AcknowledgedTransaction;
  record(value, 'transaction history entry');
  requireThat(Object.keys(value).every(key => ['schemaVersion', 'transaction', 'reload', 'writtenSources'].includes(key)), 'unexpected transaction history entry field');
  // No job argument: avoid recursively validating the containing history.
  const transaction = validateChangeSet(value.transaction);
  requireThat(transaction.status === 'applied' && transaction.jobId === job.jobId, 'transaction history requires an applied transaction of this job');
  requireThat((job.appliedTransactionIds ?? []).includes(transaction.transactionId), 'transaction history is absent from the applied transaction ledger');
  requireThat(transaction.proposalIds.every(id => job.appliedProposalIds.includes(id)), 'transaction history is absent from the applied proposal ledger');
  for (const [index, proposalId] of transaction.proposalIds.entries()) {
    const proposal = job.proposals.find(item => item.proposalId === proposalId);
    const review = job.reviews.find(item => item.reviewId === transaction.reviewIds[index]);
    requireThat(proposal && proposal.operation !== 'retain' && review?.proposalId === proposalId && review.decision === 'accept', 'transaction history requires corresponding accepted file proposals');
    requireThat(isDeepStrictEqual(review.proposalSnapshot, proposal) && isDeepStrictEqual(review.basis.scope, job.scope), 'transaction history proposal or review scope mismatch');
  }
  object(value.reload, 'transaction history reload');
  requireThat(Object.keys(value.reload).every(key => ['transactionId', 'status', 'sources', 'acknowledgedAt'].includes(key)), 'unexpected transaction history reload field');
  requireThat(value.reload.transactionId === transaction.transactionId && value.reload.status === 'ready', 'transaction history reload identity or status mismatch');
  timestamp(value.reload.acknowledgedAt, 'transaction history acknowledgedAt');
  requireThat(Date.parse(value.reload.acknowledgedAt) >= Date.parse(job.createdAt) && Date.parse(value.reload.acknowledgedAt) <= Date.parse(job.updatedAt), 'transaction history acknowledgement is outside the job lifetime');
  reloadSources(value.reload.sources, 'transaction history reload');
  if (value.writtenSources !== undefined) {
    writtenSources(value.writtenSources, transaction);
    requireThat(value.writtenSources.every(written => value.reload.sources.some(source => isDeepStrictEqual(source, written))), 'transaction history written sources must exactly match acknowledged reload sources');
  }
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
  if (value.generationDiagnostics !== undefined) validateGenerationDiagnostics(value.generationDiagnostics);
  if (value.error?.details !== undefined) {
    const details = validateGenerationAttemptDetails(value.error.details);
    requireThat(['GENERATION_VALIDATION_FAILED', 'GENERATION_ATTEMPT_SAVE_FAILED'].includes(value.error.code), 'private attempt details require a validation failure');
    requireThat(typeof value.error.message === 'string' && value.error.message.length <= 32768, 'validation failure message exceeds its private budget');
    requireThat(details.archiveState === 'saved' ? value.error.code === 'GENERATION_VALIDATION_FAILED' : value.error.code === 'GENERATION_ATTEMPT_SAVE_FAILED', 'generation archive state/code mismatch');
  }
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
  ids(value.appliedTransactionIds ?? [], 'appliedTransactionIds');
  if (value.transactionWriteReceipt !== undefined) {
    object(value.transactionWriteReceipt, 'transaction write receipt');
    requireThat(Object.keys(value.transactionWriteReceipt).every(key => ['transactionId', 'sources'].includes(key)), 'unexpected transaction write receipt field');
    requireThat(!!value.transaction && value.transactionWriteReceipt.transactionId === value.transaction.transactionId && (value.appliedTransactionIds ?? []).includes(value.transactionWriteReceipt.transactionId), 'transaction write receipt requires the current applied transaction');
    writtenSources(value.transactionWriteReceipt.sources, validateChangeSet(value.transaction));
  }
  if (value.transactionHistory !== undefined) {
    array(value.transactionHistory, 'transactionHistory');
    value.transactionHistory.forEach(entry => acknowledgedTransaction(entry, value));
    unique(value.transactionHistory.map(entry => entry.transaction.transactionId), 'transaction history IDs');
    unique(value.transactionHistory.flatMap(entry => entry.transaction.proposalIds), 'transaction history proposal IDs');
    for (let index = 1; index < value.transactionHistory.length; index++) {
      requireThat(Date.parse(value.transactionHistory[index].reload.acknowledgedAt) >= Date.parse(value.transactionHistory[index - 1].reload.acknowledgedAt), 'transaction history acknowledgement times must be ordered');
    }
  }
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
      if (!review.authority || review.authority.policyVersion !== reviewPolicyVersion(job.snapshot, proposal)) throw Object.assign(new TypeError('changeSet requires clean model acceptance authority'), { code: 'CLEAN_REVIEW_REQUIRED' });
      requireThat(proposal.operation !== 'retain', 'retention metadata cannot be a file transaction');
      requireThat(review.authority.inputDigest === cleanReviewDigest(job.snapshot, proposal), 'changeSet uses stale clean model authority');
      requireThat(!(job.invalidatedReviewIds ?? []).includes(review.reviewId), 'changeSet uses invalidated approval');
      requireThat(job.reviews.findLast((item) => item.proposalId === id) === review, 'changeSet uses an outdated review');
      requireThat(!job.appliedProposalIds.includes(id), 'changeSet would apply a proposal twice');
      validateProposal(proposal, job.snapshot);
      assertAdmission(proposal, job.snapshot);
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
