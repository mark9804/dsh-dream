import { cleanReviewDigest, reviewPolicyVersion } from '../../dist/review/isolation.js';

/** Explicit synthetic fixture authority, never used by production code. */
export function syntheticCleanAuthority(snapshot, proposal, overrides = {}) {
  return {
    kind: 'clean-model', policyVersion: reviewPolicyVersion(snapshot, proposal),
    inputDigest: cleanReviewDigest(snapshot, proposal),
    callId: `synthetic-call:${proposal.proposalId}`, provider: 'synthetic-provider', model: 'synthetic-model',
    ...overrides,
  };
}
