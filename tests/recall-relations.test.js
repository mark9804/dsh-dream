import assert from 'node:assert/strict';
import test from 'node:test';
import { recallMemory } from '../dist/dream/recall.js';
import { recallRelations } from '../dist/dream/recall-relations.js';
import { recordReview } from '../dist/review/index.js';
import { validateJob } from '../dist/domain/contracts.js';
import { cleanReviewDigest, reviewPolicyVersion } from '../dist/review/isolation.js';
const scope = { scopeId: 'synthetic-relation', agentId: 'agent', sessionId: 'agent', memoryRootId: 'synthetic-root' };
const stamp = day => `2026-11-${String(day).padStart(2, '0')}T05:30:00+09:00`;
const source = (id, content, role = 'daily', revision = 1) => ({ sourceId: id, path: id, role, content, version: { revision }, writable: role === 'longTerm', sensitivity: 'private', protectedText: [] });
const req = { query: 'amber bottle market', topic: 'synthetic bottle', conditions: 'only this object', limit: 3 };
function fixture(action = 'correct', applicabilityPatch = {}, replacement = {}) {
  const old = replacement.old ?? '- Synthetic: The amber bottle was bought at the market.\n';
  const correction = 'Synthetic direct correction: The amber bottle was a gift from Cousin, not bought at the market. Only this bottle.\n';
  const after = replacement.after ?? '- Synthetic: On November 4 Lin corrected this one bottle: it was a gift from Cousin; the earlier market-purchase account was withdrawn.\n';
  const snapshot = { schemaVersion: 1, snapshotId: 'before', scope: structuredClone(scope), capturedAt: stamp(4), sources: [source('long-term.md', old, 'longTerm'), source('daily/2026-11-04.md', correction)] };
  const proposal = { schemaVersion: 1, proposalId: 'p-correct', jobId: 'job-correct', kind: 'fact', text: 'UNTRUSTED-SUMMARY-NOT-EVIDENCE', reason: 'UNTRUSTED-REASON', targetId: 'long-term.md', operation: 'replace', before: old, after,
    evidence: [{ sourceId: 'long-term.md', quote: old }, { sourceId: 'daily/2026-11-04.md', quote: correction }],
    consolidation: { action, claimKey: 'synthetic-bottle-origin', applicability: { topic: req.topic, conditions: req.conditions, ...applicabilityPatch }, basis: 'correction' } };
  let job = { schemaVersion: 1, jobId: proposal.jobId, scope: structuredClone(scope), snapshot: structuredClone(snapshot), state: 'awaiting_review', proposals: [proposal], reviews: [], appliedProposalIds: [], createdAt: stamp(4), updatedAt: stamp(4) };
  job = recordReview(job, { jobId: job.jobId, proposalId: proposal.proposalId, decision: 'accept', reason: 'Synthetic independent exact review.' }, { agentId: 'agent', sessionId: 'agent' }, { reviewId: 'review-correct', now: stamp(4), authority: { kind: 'clean-model', policyVersion: reviewPolicyVersion(snapshot, proposal), inputDigest: cleanReviewDigest(snapshot, proposal), callId: 'synthetic-isolated-review', provider: 'synthetic', model: 'synthetic' } });
  const current = structuredClone(snapshot); current.snapshotId = 'after'; current.sources[0].content = after; current.sources[0].version = { revision: 2 };
  job.transaction = { schemaVersion: 1, transactionId: 'tx', jobId: job.jobId, status: 'applied', proposalIds: [proposal.proposalId], reviewIds: ['review-correct'], changes: [{ targetId: 'long-term.md', before: old, after, version: { revision: 1 } }] };
  job.appliedProposalIds = [proposal.proposalId]; job.appliedTransactionIds = ['tx']; job.state = 'completed';
  job.reload = { transactionId: 'tx', status: 'ready', acknowledgedAt: stamp(4), sources: current.sources.map(s => ({ sourceId: s.sourceId, path: '/synthetic/' + s.path, content: s.content, version: structuredClone(s.version) })) };
  return { snapshot, current, job, proposal };
}
const get = f => recallRelations(f.current, [f.job], new Date(stamp(10)));

test('a committed clean correction is queryable as exact current after-image, original quote and explicitly historical before-image', () => {
  const f = fixture(); const r = get(f); assert.equal(r.relations.length, 1); const link = r.relations[0];
  assert.equal(link.kind, 'reviewed-correction'); assert.equal(link.previous.kind, 'reviewed-before-image-not-current-source');
  assert.equal(link.after.text, f.proposal.after); assert.equal(link.evidence.length, 1); assert.equal(link.evidence[0].text, f.proposal.evidence[1].quote);
  assert.equal(JSON.stringify(link).includes('UNTRUSTED-'), false);
  for (const ep of [link.after, ...link.evidence]) assert.equal(f.current.sources.find(s => s.sourceId === ep.sourceId).content.slice(ep.proof.start, ep.proof.end), ep.text);
});

test('the query can reach a reviewed corrected after-image via the old wording without supplying a canonical keyword', () => {
  const f = fixture(); f.current.sources.push(source('daily/2026-11-01.md', 'Synthetic: market purchase amber bottle.\n'.repeat(1)));
  const r = recallMemory(f.current, [f.job], [], { ...req, query: 'market purchase' }, { now: new Date(stamp(10)), boost: 0 });
  assert.equal(r.hits[0].sourceId, 'long-term.md'); assert.equal(r.hits[0].consolidation.role, 'current-after-image'); assert.equal(r.relations.length, 1);
  assert.equal(r.hits[0].reinforcementBoost, 0); assert.ok(r.hits.some(h => h.sourceId === 'daily/2026-11-01.md'), 'uncited old raw record is not silently deleted');
});

test('applied reviewed merge groups referenced daily repetitions under the consolidated source but not unrelated neighboring events', () => {
  const f = fixture('merge');
  const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)), boost: 0 });
  assert.equal(r.hits[0].consolidation.action, 'merge'); assert.equal(r.hits.some(h => h.sourceId === 'daily/2026-11-04.md'), false);
  assert.equal(r.relations[0].evidence[0].sourceId, 'daily/2026-11-04.md');
});

test('unreviewed, unapplied, invalidated, forged, future or incompletely reloaded operations never link or suppress raw evidence', () => {
  const variants = [f => { f.job.reviews = []; }, f => { f.job.appliedProposalIds = []; }, f => { f.job.appliedTransactionIds = []; }, f => { f.job.invalidatedReviewIds = ['review-correct']; },
    f => { f.job.reviews[0].authority.inputDigest = 'forged'; }, f => { delete f.job.reviews[0].authority; }, f => { f.job.reviews[0].reviewedAt = stamp(20); },
    f => { f.job.reload.acknowledgedAt = stamp(20); }, f => { f.job.reload.status = 'preparing'; }, f => { f.job.reload.sources[0].version = { revision: 99 }; },
    f => { f.job.transaction.changes[0].after += ' injected'; }, f => { f.job.transaction.reviewIds = ['missing']; }];
  for (const mutate of variants) { const f = fixture(); mutate(f); assert.equal(get(f).relations.length, 0); const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)) }); assert.ok(r.hits.some(h => h.sourceId === 'daily/2026-11-04.md')); }
});

test('external edits, removed originals, changed receipts and restored bytes with a new version disable links', () => {
  const variants = [f => { f.current.sources[0].version = { revision: 3 }; }, f => { f.current.sources[0].content += ' external'; },
    f => { f.current.sources[1].version = { revision: 2 }; }, f => { f.current.sources[1].content += ' external'; }, f => { f.current.sources.pop(); },
    f => { f.current.sources[1].originals = [{ schemaVersion: 1, ref: { sessionId: 'source', seq: 1, blockIndex: 0, quote: 'Synthetic' }, status: 'unavailable', reason: 'gone', independentEvents: 'unknown' }]; }];
  for (const mutate of variants) { const f = fixture(); mutate(f); assert.equal(get(f).relations.length, 0); }
});

test('daily rollover and unrelated added files do not prevent an exact read-only operation link or restore old reinforcement', () => {
  const f = fixture(); f.current.sources.push(source('daily/2026-11-10.md', 'Synthetic unrelated weather.\n'));
  const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)), boost: 0.25 }); assert.equal(r.relations.length, 1); assert.ok(r.hits.every(h => h.reinforcementBoost === 0));
});

test('a newer same-claim rejection or scoped correction suppresses the older relation rather than reviving it', () => {
  const f = fixture(); const newer = structuredClone(f.job); newer.jobId = 'newer'; newer.proposals[0].jobId = 'newer'; newer.reviews = []; newer.appliedProposalIds = []; delete newer.transaction; delete newer.reload;
  const rejected = recordReview({ ...newer, state: 'awaiting_review' }, { jobId: newer.jobId, proposalId: newer.proposals[0].proposalId, decision: 'reject', reason: 'New scoped decision.' }, { agentId: 'agent', sessionId: 'agent' }, { reviewId: 'new-veto', now: stamp(6) });
  const r = recallRelations(f.current, [f.job, rejected], new Date(stamp(10))); assert.equal(r.relations.length, 0);
  assert.ok(r.coverage.diagnostics.some(d => d.disabledReasons.includes('newer-scoped-decision')));
});

test('group suppression never hides an identical but uncited independent dated occurrence', () => {
  const f = fixture(); const independent = structuredClone(f.current.sources[1]); independent.sourceId = 'daily/2026-11-03.md'; independent.path = independent.sourceId; f.current.sources.push(independent);
  const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)) });
  assert.ok(r.hits.some(h => h.group?.members.some(m => m.sourceId === independent.sourceId)), 'uncited identical date remains in a visible display group');
});

test('out-of-period and cross-request links retain applicability and cannot fold raw evidence into a current-scope conclusion', () => {
  const f = fixture();
  const r = recallMemory(f.current, [f.job], [], { ...req, topic: 'another context' }, { now: new Date(stamp(10)) });
  assert.ok(r.hits.some(h => h.sourceId === 'daily/2026-11-04.md'));
  assert.equal(r.hits.find(h => h.sourceId === 'long-term.md').consolidation.applicabilityMatch, 'different-request-scope');
});

test('future and expired applicability links cannot fold raw evidence or present a currently applicable canonical claim', () => {
  for (const range of [{ validFrom: stamp(11) }, { validUntil: stamp(9) }]) {
    const f = fixture('correct', range); const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)) });
    assert.ok(r.hits.some(h => h.sourceId === 'daily/2026-11-04.md'));
    assert.equal(r.hits.find(h => h.sourceId === 'long-term.md').consolidation.applicabilityMatch, 'out-of-time');
    assert.equal(r.relations[0].applicability.validFrom ?? r.relations[0].applicability.validUntil, range.validFrom ?? range.validUntil);
  }
});

test('ambiguous reload receipts and incomplete sibling commit ledgers cannot activate operation links', () => {
  const f = fixture(); f.job.reload.sources.push({ ...structuredClone(f.job.reload.sources[0]), content: 'conflicting receipt' }); assert.equal(get(f).relations.length, 0);
  const g = fixture(); g.job.transaction.proposalIds.push('missing-sibling'); assert.equal(get(g).relations.length, 0);
});

test('current canonical is not lost inside a higher-ranked unreviewed identical display group', () => {
  const f = fixture(); f.current.sources.push(source('aaa-copy.md', f.proposal.after));
  const r = recallMemory(f.current, [f.job], [], req, { now: new Date(stamp(10)) });
  assert.equal(r.hits[0].sourceId, 'long-term.md'); assert.equal(r.hits[0].consolidation.role, 'current-after-image');
});

test('long neighboring text cannot lend its query relevance to a clipped or exact unrelated reviewed after-image', () => {
  const f = fixture(); const original = f.current.sources[0];
  // A changed target correctly disables the link, so construct the reviewed
  // before/after source with a long untouched suffix already in its transaction.
  const suffix = ' '.repeat(30) + 'synthetic hospital Tuesday appointment ' + '🐋'.repeat(1500);
  f.snapshot.sources[0].content += suffix; f.job.snapshot.sources[0].content += suffix;
  f.job.reviews[0].basis.sources.find(s => s.sourceId === 'long-term.md').content += suffix;
  f.job.reviews[0].authority.inputDigest = cleanReviewDigest({ ...f.snapshot }, f.proposal);
  f.job.transaction.changes[0].before += suffix; f.job.transaction.changes[0].after += suffix;
  original.content += suffix; f.job.reload.sources[0].content += suffix;
  const r = recallMemory(f.current, [f.job], [], { query: 'hospital Tuesday', topic: 'medical', conditions: 'this appointment only', limit: 1 }, { now: new Date(stamp(10)) });
  assert.ok(r.hits[0].text.includes('hospital Tuesday')); assert.notEqual(r.hits[0].consolidation?.role, 'current-after-image');
});

test('sensitive source state survives representative, duplicate member and reviewed endpoint metadata', () => {
  const f = fixture();
  // Sensitivity is source-owned; changing it after approval invalidates that link.
  f.current.sources[1].sensitivity = 'sensitive'; assert.equal(get(f).relations.length, 0);
  const r = recallMemory(f.current, [], [], req, { now: new Date(stamp(10)) }); assert.equal(r.hits.find(h => h.sourceId === 'daily/2026-11-04.md').sensitivity, 'sensitive');
  const copy = structuredClone(f.current.sources[1]); copy.sourceId = 'daily/another.md'; copy.path = copy.sourceId; copy.sensitivity = 'private'; f.current.sources.push(copy);
  const grouped = recallMemory(f.current, [], [], req, { now: new Date(stamp(10)) }); const group = grouped.hits.find(h => h.group);
  assert.ok(group.group.members.some(m => m.sensitivity === 'sensitive')); assert.ok(group.group.members.some(m => m.sensitivity === 'private'));
  const normal = get(fixture()); assert.equal(normal.relations[0].after.sensitivity, 'private'); assert.equal(normal.relations[0].previous.sensitivity, 'private');
});

test('overlapping after-image occurrences use the approved edit offset rather than guessing by text uniqueness', () => {
  const f = fixture('correct', {}, { old: 'X', after: 'no no' });
  // Preserve approved surrounding bytes: replacing X in "no X" produces two
  // overlapping matches of "no no"; the exact approved replacement starts at 3.
  f.snapshot.sources[0].content = 'no X'; f.job.snapshot.sources[0].content = 'no X'; f.job.reviews[0].basis.sources.find(s => s.sourceId === 'long-term.md').content = 'no X';
  f.proposal.evidence[0].quote = 'X'; f.job.reviews[0].proposalSnapshot.evidence[0].quote = 'X';
  f.job.proposals[0].evidence[0].quote = 'X';
  delete f.job.reviews[0].proposalSnapshot.lineage;
  f.job.reviews[0].authority.inputDigest = cleanReviewDigest(f.snapshot, f.job.proposals[0]);
  f.job.transaction.changes[0].before = 'no X'; f.job.transaction.changes[0].after = 'no no no'; f.current.sources[0].content = 'no no no'; f.job.reload.sources[0].content = 'no no no';
  validateJob(f.job);
  const r = get(f); assert.equal(r.relations.length, 1); assert.equal(r.relations[0].after.proof.start, 3); assert.equal(r.relations[0].after.proof.end, 8);
});

test('incidental shared words cannot activate a weak exact-scope relation ahead of a direct answer', () => {
  const f = fixture(); f.current.sources.push(source('daily/2026-11-09.md', 'Synthetic market refund voucher.'));
  const r = recallMemory(f.current, [f.job], [], { ...req, query: 'market refund voucher', limit: 1 }, { now: new Date(stamp(10)) });
  assert.equal(r.hits[0].sourceId, 'daily/2026-11-09.md'); assert.equal(r.hits[0].consolidation, undefined);
});

test('dense but bounded repeated paragraphs do not overflow JavaScript argument limits before grouping', () => {
  const f = fixture(); f.current.sources = Array.from({ length: 4 }, (_, n) => source(`daily/dense-${n}.md`, 'x\n\n'.repeat(33000)));
  const r = recallMemory(f.current, [], [], { ...req, query: 'x', limit: 2 }, { now: new Date(stamp(10)) });
  assert.equal(r.hits.length, 1); assert.equal(r.hits[0].group.memberCount, 132000); assert.equal(r.coverage.grouping.collapsedHits, 131999);
});

test('aggregate output bounds whole relations and member locations without inventing clipped proofs', () => {
  const f = fixture(); const giant = 'Synthetic bottle detail ' + '🐋'.repeat(1200); f.current.sources.push(...Array.from({ length: 100 }, (_, n) => source(`daily/large-${n}.md`, giant)));
  const r = recallMemory(f.current, [f.job], [], { ...req, query: 'bottle detail amber', limit: 50 }, { now: new Date(stamp(10)) });
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 65536); assert.equal(r.coverage.byteBudget.outputBytes, Buffer.byteLength(JSON.stringify(r)));
  for (const hit of r.hits) if (hit.consolidation) assert.ok(r.relations.some(rel => rel.relationId === hit.consolidation.relationId));
});

test('exact duplicate display grouping operates before topK with truthful location counts and cannot merge negation or separate dates into one event', () => {
  const f = fixture(); const text = 'Synthetic unchanged shared detail.\n'; f.current.sources.push(...Array.from({ length: 30 }, (_, n) => source(`daily/copy-${n}.md`, text)));
  const r = recallMemory(f.current, [], [], { ...req, query: 'shared detail', limit: 2 }, { now: new Date(stamp(10)) });
  assert.equal(r.hits.length, 1); assert.equal(r.hits[0].group.memberCount, 30); assert.equal(r.hits[0].group.independentEvents, 'unknown'); assert.equal(r.coverage.grouping.collapsedHits, 29);
});
