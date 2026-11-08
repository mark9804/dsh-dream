import { createHash } from 'node:crypto';
import type { Proposal, Scope, Snapshot, Source } from '../types.js';

export interface CleanReviewPayload {
  policyVersion: 1 | 2 | 3;
  scope: Scope;
  sources: Source[];
  candidates?: Snapshot['candidates'];
  originalCoverage?: Snapshot['originalCoverage'];
  proposal: Pick<Proposal, 'proposalId' | 'jobId' | 'kind' | 'targetId' | 'operation' | 'before' | 'after' | 'evidence' | 'consolidation' | 'lineage'>;
}

/** Copy only the review's authoritative inputs, never a dream or its persuasion. */
export function buildCleanReviewPayload(snapshot: Snapshot, proposal: Proposal, policyVersion: 1 | 2 | 3 = reviewPolicyVersion(snapshot, proposal)): CleanReviewPayload {
  return structuredClone({
    policyVersion,
    ...(policyVersion >= 3 && snapshot.originalCoverage ? { originalCoverage: snapshot.originalCoverage } : {}),
    ...(policyVersion >= 2 && snapshot.candidates ? { candidates: snapshot.candidates } : {}),
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
      ...(policyVersion >= 2 && source.provenance ? { provenance: source.provenance } : {}),
      ...(policyVersion >= 3 && source.originals ? { originals: source.originals } : {}),
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
      ...(policyVersion >= 2 && proposal.consolidation ? { consolidation: proposal.consolidation } : {}),
      ...(policyVersion >= 2 && proposal.lineage ? { lineage: proposal.lineage } : {}),
    },
  });
}

/** Bind approval to the exact whitelist, including uncited sources and versions. */
export function reviewPolicyVersion(snapshot: Snapshot, proposal: Proposal): 1 | 2 | 3 {
  if (snapshot.originalCoverage || snapshot.sources.some(s => s.originals !== undefined)) return 3;
  return snapshot.candidates || snapshot.sources.some(s => s.provenance) || proposal.consolidation || proposal.lineage ? 2 : 1;
}

export function cleanReviewDigest(snapshot: Snapshot, proposal: Proposal, policyVersion: 1 | 2 | 3 = reviewPolicyVersion(snapshot, proposal)): string {
  return createHash('sha256').update(JSON.stringify(buildCleanReviewPayload(snapshot, proposal, policyVersion))).digest('hex');
}
