import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateJob, validateSnapshot } from '../domain/contracts.js';
import { reviewMatches } from '../review/index.js';
import { candidateId } from './lineage.js';
import { createRecallContinuity, reviewSnapshot, sameSourceShape } from './recall-continuity.js';
import type { ContinuityCoverage } from './recall-continuity.js';
import type { Applicability, Job, Proposal, Review, Snapshot, Source, Version } from '../types.js';

const MAX_RELATIONS = 32, MAX_ENDPOINTS = 64, MAX_DIAGNOSTICS = 64, MAX_RELATION_BYTES = 16384;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalizeScope = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/gu, ' ');
const decisionKey = (proposal: Proposal, snapshot: Snapshot) => candidateId({ ...proposal.consolidation!, applicability: { ...proposal.consolidation!.applicability, topic: normalizeScope(proposal.consolidation!.applicability.topic), conditions: normalizeScope(proposal.consolidation!.applicability.conditions) } }, snapshot.scope);
const at = (text: unknown) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(text) ? Date.parse(text) : NaN;
export interface RecallRelationEndpoint {
  sourceId: string; path: string; sourceRole: Source['role']; sensitivity: Source['sensitivity']; version: Version; text: string;
  proof: { kind: 'current-source'; contentHash: string; start: number; end: number; offsetUnit: 'utf16-code-units' };
}
export interface RecallRelation {
  relationId: string; kind: 'reviewed-merge' | 'reviewed-correction'; meaning: 'reviewed-operation-link-not-independent-truth';
  jobId: string; proposalId: string; reviewId: string; transactionId: string; claimKey: string; applicability: Applicability; reviewedAt: string;
  continuity?: { kind: 'exact-reviewed-write-chain'; continuedThrough: string[]; chainHash: string; meaning: 'unrelated-approved-edits-only-not-renewed-approval' };
  after: RecallRelationEndpoint; evidence: RecallRelationEndpoint[];
  previous: { sourceId: string; sensitivity: Source['sensitivity']; text: string; contentHash: string; version: Version; kind: 'reviewed-before-image-not-current-source' };
}
export interface RecallRelationDiagnostic { jobId: string; proposalId: string; eligible: boolean; disabledReasons: string[] }
export interface RecallRelationCoverage { considered: number; eligible: number; returned: number; omitted: number; diagnostics: RecallRelationDiagnostic[]; omittedDiagnostics: number; policy: string; continuity?: ContinuityCoverage }
function endpoint(source: Source, text: string, start: number): RecallRelationEndpoint {
  return { sourceId: source.sourceId, path: source.path, sourceRole: source.role, sensitivity: source.sensitivity, version: structuredClone(source.version), text,
    proof: { kind: 'current-source', contentHash: hash(source.content), start, end: start + text.length, offsetUnit: 'utf16-code-units' } };
}
function occurrences(source: Source, text: string): RecallRelationEndpoint[] {
  const result: RecallRelationEndpoint[] = []; if (!text.trim()) return result;
  let start = source.content.indexOf(text);
  while (start !== -1 && result.length <= MAX_ENDPOINTS) { result.push(endpoint(source, text, start)); start = source.content.indexOf(text, start + 1); }
  return result;
}
interface DecisionEvent { job: Job; proposal: Proposal; review: Review; valid: boolean; time: number; tie: string }
function authentic(event: DecisionEvent): boolean {
  if (!event.valid || event.review.decision !== 'accept' || event.job.invalidatedReviewIds?.includes(event.review.reviewId)) return false;
  try { return reviewMatches({ ...event.job, snapshot: reviewSnapshot(event.review) }, event.review); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
}
/** A later genuine keep/reinforce can retain an applied operation link, but can
 * never restore it past any intervening veto, invalidation or replacement. The
 * query scope is still the ORIGINAL operation's scope, not the later review's. */
function superseded(events: DecisionEvent[], origin: DecisionEvent): boolean {
  for (const event of events) {
    if (event.review === origin.review || isDeepStrictEqual(event.review, origin.review) || event.time < origin.time) continue;
    if (event.time === origin.time && event.tie < origin.tie && authentic(event)) continue;
    if (!['keep', 'reinforce'].includes(event.proposal.consolidation!.action) || !authentic(event)) return true;
  }
  return false;
}
/** Query-only links use frozen approvals and actual acknowledged write chains.
 * Every original non-target source remains exact current evidence. Unrelated
 * later approved edits may transport an untouched endpoint, never approval. */
export function recallRelations(snapshot: Snapshot, history: Job[], now: Date): { relations: RecallRelation[]; coverage: RecallRelationCoverage } {
  validateSnapshot(snapshot);
  if (!Array.isArray(history) || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Relation history and clock are required');
  const catalog = createRecallContinuity(snapshot, history, now);
  const coverage: RecallRelationCoverage = { considered: 0, eligible: 0, returned: 0, omitted: 0, diagnostics: [], omittedDiagnostics: 0, continuity: catalog.coverage,
    policy: 'Applied clean-reviewed operations with actual reread receipts, exact current raw evidence and an unbroken approved write/version chain. Untouched endpoints only; cross-batch history never renews approval/boost or factual truth. Later vetoes always block; genuine keeps cannot resurrect a veto. Legacy exact after-images remain readable but cannot authorize continuity. At most32 relations/64 endpoints; incomplete chains and oversized links omitted, current raw conflicts stay visible.' };
  const candidates: DecisionEvent[] = [], decisions = new Map<string, DecisionEvent[]>(), candidateKeys = new Set<string>();
  // Process ALL decisions before bounded transaction/chain selection; a budget
  // may disable old links but can never hide a newer veto and revive one.
  for (const job of history) {
    if (!job || !isDeepStrictEqual(job.scope, snapshot.scope) || !Array.isArray(job.proposals) || !Array.isArray(job.reviews)) continue;
    let valid = true; try { validateJob(job); } catch (error) { if (!(error instanceof TypeError)) throw error; valid = false; }
    for (const proposal of job.proposals) {
      if (!proposal?.consolidation?.claimKey || !proposal.consolidation.applicability) continue;
      let key: string; try { key = decisionKey(proposal, snapshot); } catch { continue; }
      const events = decisions.get(key) ?? [];
      for (const review of job.reviews.filter(r => r?.proposalId === proposal.proposalId)) {
        const time = at(review.reviewedAt); if (Number.isFinite(time) && time > now.getTime()) continue;
        events.push({ job, proposal, review, valid, time: Number.isFinite(time) ? time : Infinity, tie: `${job.jobId}:${review.reviewId}` });
      }
      decisions.set(key, events);
      if (['merge', 'correct'].includes(proposal.consolidation.action)) {
        const last = events.filter(e => e.job === job && e.proposal === proposal).at(-1);
        if (last) { const identity = JSON.stringify([job.jobId, proposal.proposalId, last.review.reviewId]); if (!candidateKeys.has(identity)) { candidateKeys.add(identity); candidates.push(last); } }
      }
    }
  }
  candidates.sort((a, b) => b.time - a.time || compare(a.tie, b.tie));
  const relations: RecallRelation[] = [];
  for (const item of candidates) {
    const { job, proposal, review } = item; coverage.considered++; const reasons: string[] = [];
    if (!item.valid) reasons.push('invalid-job');
    if (!authentic(item)) reasons.push('invalid-clean-review');
    if (!Number.isFinite(item.time) || item.time > now.getTime()) reasons.push('review-time-unavailable-or-future');
    const key = decisionKey(proposal, snapshot);
    if (superseded(decisions.get(key) ?? [], item)) reasons.push('newer-scoped-decision');
    const record = catalog.find(job.jobId, proposal.proposalId, review.reviewId);
    if (proposal.operation !== 'replace' || !record) reasons.push('not-applied-and-reread');
    const current = !reasons.length && record ? catalog.endpoint(record, proposal) : undefined;
    if (!current && !reasons.length) reasons.push('target-after-image-changed-or-chain-unavailable');
    const evidence: RecallRelationEndpoint[] = [];
    if (current && record) {
      const basis = reviewSnapshot(review);
      for (const cited of proposal.evidence) {
        const old = basis.sources.find(s => s.sourceId === cited.sourceId), source = snapshot.sources.find(s => s.sourceId === cited.sourceId);
        if (cited.sourceId === proposal.targetId) {
          if (!old || !old.content.includes(cited.quote)) reasons.push('historical-target-evidence-invalid');
          continue;
        }
        if (!old || !source || !sameSourceShape(source, old) || source.content !== old.content || !isDeepStrictEqual(source.version, old.version)) { reasons.push('evidence-source-changed-or-unavailable'); continue; }
        const matches = occurrences(source, cited.quote);
        if (!matches.length || matches.length > MAX_ENDPOINTS || evidence.length + matches.length > MAX_ENDPOINTS) { reasons.push('evidence-location-budget-or-missing'); continue; }
        evidence.push(...matches);
      }
      if (!evidence.length) reasons.push('no-current-event-evidence');
    }
    let relation: RecallRelation | undefined;
    if (!reasons.length && current && record) {
      const oldTarget = review.basis.sources.find(s => s.sourceId === proposal.targetId)!;
      relation = { relationId: `relation-${hash(`${job.jobId}:${proposal.proposalId}:${review.reviewId}`)}`, kind: proposal.consolidation!.action === 'merge' ? 'reviewed-merge' : 'reviewed-correction', meaning: 'reviewed-operation-link-not-independent-truth',
        jobId: job.jobId, proposalId: proposal.proposalId, reviewId: review.reviewId, transactionId: record.transaction.transactionId,
        claimKey: proposal.consolidation!.claimKey, applicability: structuredClone(proposal.consolidation!.applicability), reviewedAt: review.reviewedAt,
        ...(current.transactionIds.length ? { continuity: { kind: 'exact-reviewed-write-chain', continuedThrough: current.transactionIds, chainHash: catalog.chainHash(current.transactionIds), meaning: 'unrelated-approved-edits-only-not-renewed-approval' } as const } : {}),
        after: endpoint(current.source, proposal.after, current.range.start), evidence: evidence.filter((ep, i) => evidence.findIndex(other => other.sourceId === ep.sourceId && other.proof.start === ep.proof.start && other.proof.end === ep.proof.end) === i),
        previous: { sourceId: proposal.targetId, sensitivity: oldTarget.sensitivity, text: proposal.before, version: structuredClone(oldTarget.version), contentHash: hash(oldTarget.content), kind: 'reviewed-before-image-not-current-source' } };
      if (Buffer.byteLength(JSON.stringify(relation)) > MAX_RELATION_BYTES) { reasons.push('relation-byte-budget'); relation = undefined; }
    }
    const eligible = !!relation; if (eligible) coverage.eligible++;
    if (relation && relations.length < MAX_RELATIONS) relations.push(relation); else if (relation || reasons.includes('relation-byte-budget')) coverage.omitted++;
    const diagnostic = { jobId: job.jobId, proposalId: proposal.proposalId, eligible, disabledReasons: [...new Set(reasons)] };
    if (coverage.diagnostics.length < MAX_DIAGNOSTICS && Buffer.byteLength(JSON.stringify(diagnostic)) <= 2048) coverage.diagnostics.push(diagnostic); else coverage.omittedDiagnostics++;
  }
  coverage.returned = relations.length; return { relations, coverage };
}
