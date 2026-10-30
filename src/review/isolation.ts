import { createHash } from 'node:crypto';
import type { Proposal, Scope, Snapshot, Source } from '../types.js';

export interface CleanReviewPayload {
  policyVersion: 1;
  scope: Scope;
  sources: Source[];
  proposal: Pick<Proposal, 'proposalId' | 'jobId' | 'kind' | 'targetId' | 'operation' | 'before' | 'after' | 'evidence'>;
}

/** Copy only the review's authoritative inputs, never a dream or its persuasion. */
export function buildCleanReviewPayload(snapshot: Snapshot, proposal: Proposal): CleanReviewPayload {
  return structuredClone({
    policyVersion: 1,
    scope: {
      scopeId: snapshot.scope.scopeId,
      agentId: snapshot.scope.agentId,
      sessionId: snapshot.scope.sessionId,
      memoryRootId: snapshot.scope.memoryRootId,
    },
    // Include every source, not just cited evidence: other sources may contradict
    // a claim or contain persona, protected text, and relevant context.
    sources: snapshot.sources.toSorted((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0).map(source => ({
      sourceId: source.sourceId,
      path: source.path,
      role: source.role,
      content: source.content,
      version: source.version,
      writable: source.writable,
      sensitivity: source.sensitivity,
      protectedText: source.protectedText,
    })),
    proposal: {
      proposalId: proposal.proposalId,
      jobId: proposal.jobId,
      kind: proposal.kind,
      targetId: proposal.targetId,
      operation: proposal.operation,
      before: proposal.before,
      after: proposal.after,
      evidence: proposal.evidence.map(evidence => ({ sourceId: evidence.sourceId, quote: evidence.quote })),
    },
  });
}

/** Bind approval to the exact whitelist, including uncited sources and versions. */
export function cleanReviewDigest(snapshot: Snapshot, proposal: Proposal): string {
  return createHash('sha256').update(JSON.stringify(buildCleanReviewPayload(snapshot, proposal))).digest('hex');
}
