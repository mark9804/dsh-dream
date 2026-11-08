import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateChangeSet, validateJob, validateSnapshot } from '../domain/contracts.js';
import { reviewMatches } from '../review/index.js';
import { candidateId } from './lineage.js';
import { groupRecallHits } from './recall-groups.js';
import type { RecallHitGroup, RecallGroupingCoverage } from './recall-groups.js';
import { recallRelations } from './recall-relations.js';
import type { RecallRelation, RecallRelationCoverage } from './recall-relations.js';
import type { RecallMaterialCoverage } from './recall-materials.js';
import type { Applicability, Consolidation, Job, RecallRequest, ReinforcementControl, Review, Scope, Snapshot, Source, Version } from '../types.js';

const MAX_TEXT_BYTES = 2048;
const MAX_OUTPUT_BYTES = 65536;
const MAX_RESULTS = 50;
const MAX_DIAGNOSTICS = 64;
const DEFAULT_BOOST = 0.25;
const actions = ['add', 'keep', 'reinforce', 'merge', 'correct', 'promote', 'needs-verification'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): number => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

type Event = { job: Job; proposal: Job['proposals'][number]; review?: Review; at: number; tie: string; validJob: boolean };
type Range = { start: number; end: number };
type Word = Range & { term: string };

export interface ReinforcementDiagnostic {
  candidateId: string;
  claimKey: string;
  applicability: Applicability;
  sourceId: string;
  eligible: boolean;
  disabledReasons: string[];
  jobId: string;
  reviewId?: string;
}
export interface RecallHit {
  sourceId: string;
  path: string;
  sourceRole: Source['role'];
  sensitivity?: Source['sensitivity'];
  temporalStatus: 'dated-record-not-current-status' | 'current-file-not-independent-truth';
  version: Version;
  text: string;
  score: number;
  baseScore: number;
  reinforcementBoost: number;
  candidateId?: string;
  applicability?: Applicability;
  reinforcement?: { eligible: boolean; disabledReasons: string[]; reviewId?: string };
  group?: RecallHitGroup;
  consolidation?: { relationId: string; role: 'current-after-image' | 'historical-evidence'; action: 'merge' | 'correct'; applicabilityMatch: 'exact-request' | 'different-request-scope' | 'out-of-time'; meaning: 'reviewed-operation-not-independent-truth' };
  retrievalReason?: 'lexical-match' | 'linked-reviewed-after-image';
  sourceVerification: { verified: number; unavailable: number; invalid: number; independentEvents: 'unknown'; meaning: 'original-location-only-not-factual-credibility' };
  proof: { kind: 'current-source'; contentHash: string; start: number; end: number; fragmentStart: number; fragmentEnd: number; offsetUnit: 'utf16-code-units'; textBytes: number; fragmentBytes: number; truncated: boolean };
}
export interface RecallResult {
  hits: RecallHit[];
  relations?: RecallRelation[];
  coverage: {
    snapshotId: string | null; sourcesScanned: number; queryTerms: number; lexicalMatches: number; returnedHits: number;
    resultsTruncated: boolean; snippetsTruncated: number; historyJobsConsidered: number; historyJobsIgnored: number; controlsIgnored: number;
    reinforcement: { items: ReinforcementDiagnostic[]; total: number; truncated: boolean };
    originalCoverage?: Snapshot['originalCoverage'];
    materials?: RecallMaterialCoverage;
    grouping?: RecallGroupingCoverage;
    relations?: RecallRelationCoverage;
    byteBudget: { maxBytes: number; outputBytes: number; omittedHits: number; omittedDiagnostics: number; omittedMetadata: string[] };
  };
  policy: {
    retrieval: string; applicability: string; freshness: string; reinforcement: string; sourceVerification: string;
    normalizedRequest: { topic: string; conditions: string } | null; now: string; configuredBoost: number; maxTextBytes: number; maxResults: number;
  };
}

/** Presentation-only omissions: never clip applicability, versions or IDs into
 * misleading partial values, and never mutate the authoritative input records. */
function boundResult(result: RecallResult): RecallResult {
  const budget = result.coverage.byteBudget;
  const measure = () => {
    // Include the length of the byte-count field itself in the final budget.
    for (let i = 0; i < 8; i++) {
      const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (size === budget.outputBytes) return size;
      budget.outputBytes = size;
    }
    return Buffer.byteLength(JSON.stringify(result), 'utf8');
  };
  while (measure() > budget.maxBytes) {
    if (result.coverage.reinforcement.items.length) {
      result.coverage.reinforcement.items.pop(); budget.omittedDiagnostics++;
      result.coverage.reinforcement.truncated = true;
    } else if (result.relations?.length) {
      const omitted = result.relations.pop()!; budget.omittedMetadata.push('relations.item');
      const removedCanonical = result.hits.filter(hit => hit.consolidation?.relationId === omitted.relationId && hit.consolidation.role === 'current-after-image');
      result.hits = result.hits.filter(hit => !removedCanonical.includes(hit));
      budget.omittedHits += removedCanonical.length;
      for (const hit of result.hits) if (hit.consolidation?.relationId === omitted.relationId) delete hit.consolidation;
      result.coverage.returnedHits = result.hits.length;
      result.coverage.resultsTruncated = true;
      result.coverage.snippetsTruncated = result.hits.filter(hit => hit.proof.truncated).length;
      if (result.coverage.relations) { result.coverage.relations.returned = result.relations.length; result.coverage.relations.omitted++; }
    } else if (result.coverage.relations?.diagnostics.length) {
      result.coverage.relations.diagnostics.pop(); result.coverage.relations.omittedDiagnostics++;
    } else if (result.hits.some(hit => hit.group?.members.length)) {
      const hit = result.hits.findLast(item => item.group?.members.length)!;
      hit.group!.members.pop(); hit.group!.omittedMembers++;
      if (result.coverage.grouping) result.coverage.grouping.omittedMemberLocations++;
    } else if (result.hits.length) {
      result.hits.pop(); budget.omittedHits++;
      result.coverage.returnedHits = result.hits.length;
      result.coverage.resultsTruncated = true;
      result.coverage.snippetsTruncated = result.hits.filter(hit => hit.proof.truncated).length;
    } else if (result.coverage.materials?.omissions.length) {
      result.coverage.materials.omissions.pop(); result.coverage.materials.omittedDiagnostics++;
    } else if (result.policy.normalizedRequest !== null) {
      result.policy.normalizedRequest = null; budget.omittedMetadata.push('policy.normalizedRequest');
    } else if (result.coverage.originalCoverage !== undefined) {
      delete result.coverage.originalCoverage; budget.omittedMetadata.push('coverage.originalCoverage');
    } else if (result.coverage.snapshotId !== null) {
      result.coverage.snapshotId = null; budget.omittedMetadata.push('coverage.snapshotId');
    } else {
      throw new RangeError('recall output metadata exceeds its byte budget');
    }
  }
  return result;
}

function validConsolidation(value: unknown): value is Consolidation {
  if (!record(value) || !actions.includes(value.action as string) || typeof value.claimKey !== 'string' || !value.claimKey.trim()) return false;
  const a = value.applicability;
  return record(a) && typeof a.topic === 'string' && typeof a.conditions === 'string'
    && (a.validFrom === undefined || typeof a.validFrom === 'string') && (a.validUntil === undefined || typeof a.validUntil === 'string');
}

/** A review is checked against its stored input, never a newly annotated candidate
 * view. Current-file freshness is a separate comparison below. */
function authentic(event: Event): boolean {
  if (!event.validJob || !event.review) return false;
  try { return reviewMatches(event.job, event.review); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
}

function blockPriority(event: Event): number {
  return !event.validJob || event.review?.decision !== 'accept' || event.proposal.consolidation?.action !== 'reinforce'
    || event.job.invalidatedReviewIds?.includes(event.review.reviewId) ? 1 : 0;
}

function newer(left: Event, right: Event): boolean {
  // Invalid dates are fail-closed rather than silently reviving an older approval.
  if (left.at !== right.at) return left.at > right.at;
  const order = blockPriority(left) - blockPriority(right);
  return order ? order > 0 : compare(left.tie, right.tie) > 0;
}

function historicalEvents(history: Job[], scope: Scope, now: number) {
  const events = new Map<string, Event>();
  let considered = 0, ignored = 0;
  for (const job of history) {
    if (!record(job) || !isDeepStrictEqual(job.scope, scope) || !record(job.snapshot)
      || !isDeepStrictEqual(job.snapshot.scope, scope) || !Array.isArray(job.proposals) || !Array.isArray(job.reviews)) { ignored++; continue; }
    considered++;
    let validJob = true;
    try { validateJob(job); } catch (error) { if (!(error instanceof TypeError)) throw error; validJob = false; }
    for (const proposal of job.proposals) {
      if (!record(proposal) || !validConsolidation(proposal.consolidation)) continue;
      const id = candidateId(proposal.consolidation, scope);
      const reviews = job.reviews.filter(review => record(review) && review.proposalId === proposal.proposalId);
      // Unreviewed proposals remain discoverable, but generated text is not a veto.
      if (!reviews.length && !events.has(id)) events.set(id, { job, proposal, validJob, at: -Infinity, tie: `${job.jobId}:${proposal.proposalId}` });
      for (const review of reviews) {
        const parsed = timestamp(review.reviewedAt);
        if (Number.isFinite(parsed) && parsed > now) continue;
        const event: Event = { job, proposal, review, validJob, at: Number.isFinite(parsed) ? parsed : Infinity,
          tie: `${job.jobId}:${review.reviewId}` };
        const previous = events.get(id);
        if (!previous || newer(event, previous)) events.set(id, event);
      }
    }
  }
  return { events, considered, ignored };
}

function latestControls(controls: ReinforcementControl[], scope: Scope, now: number) {
  const latest = new Map<string, ReinforcementControl>();
  let ignored = 0;
  for (const control of controls) {
    if (!record(control) || control.schemaVersion !== 1 || typeof control.candidateId !== 'string' || !control.candidateId.trim()
      || typeof control.enabled !== 'boolean' || typeof control.reason !== 'string' || !control.reason.trim()
      || !isDeepStrictEqual(control.scope, scope) || !record(control.actor)
      || control.actor.agentId !== scope.agentId || control.actor.sessionId !== scope.sessionId
      || !Number.isFinite(timestamp(control.at)) || timestamp(control.at) > now) { ignored++; continue; }
    const prior = latest.get(control.candidateId);
    // Revoke wins an ambiguous timestamp tie; input order is never authority.
    if (!prior || timestamp(control.at) > timestamp(prior.at) || (timestamp(control.at) === timestamp(prior.at) && !control.enabled)) latest.set(control.candidateId, control);
  }
  return { latest, ignored };
}

/** A sibling write in the SAME reviewed job has one narrow continuation: its
 * recorded approved after-image, actually reread and acknowledged. Revalidate the
 * full edit plan through the prepared contract, since its applied branch checks
 * history shape only. This does not write, replay, or rebase the job. */
function acknowledgedAfterImages(event: Event, snapshot: Snapshot, now: number): Map<string, Source> | undefined {
  const { job, review } = event;
  const tx = job.transaction, reload = job.reload;
  if (!event.validJob || !review || !tx || !reload || reload.status !== 'ready'
    || !['prepared', 'applying', 'applied'].includes(tx.status)
    || reload.transactionId !== tx.transactionId || !job.appliedTransactionIds?.includes(tx.transactionId)
    || !Array.isArray(tx.proposalIds) || !tx.proposalIds.every(id => job.appliedProposalIds.includes(id))
    || !Number.isFinite(timestamp(reload.acknowledgedAt)) || timestamp(reload.acknowledgedAt) > now
    || timestamp(reload.acknowledgedAt) < timestamp(review.reviewedAt)
    || !Array.isArray(reload.sources) || new Set(reload.sources.map(source => source.sourceId)).size !== reload.sources.length) return;
  try {
    validateChangeSet({ ...tx, status: 'prepared' }, { ...job, transactionHistory: undefined, state: 'prepared', committingProposalIds: [...tx.proposalIds],
      appliedProposalIds: job.appliedProposalIds.filter(id => !tx.proposalIds.includes(id)) });
    if (tx.reviewIds.some(id => {
      const approval = job.reviews.find(item => item.reviewId === id);
      return !approval || timestamp(approval.reviewedAt) > timestamp(reload.acknowledgedAt);
    })) return;
  } catch (error) { if (error instanceof TypeError) return; throw error; }
  const result = new Map<string, Source>();
  for (const change of tx.changes) {
    const before = review.basis.sources.find(source => source.sourceId === change.targetId);
    if (!before) {
      // Archive outputs are outside the collected source set. Their exact bytes
      // were already checked as part of the reconstructed approved transaction.
      if (change.targetId.startsWith('archive:')) continue;
      return;
    }
    const current = snapshot.sources.find(source => source.sourceId === change.targetId);
    const receipt = reload.sources.find(source => source.sourceId === change.targetId);
    if (!current || !receipt || before.content !== change.before || !isDeepStrictEqual(before.version, change.version)
      || current.content !== change.after || receipt.content !== change.after || !isDeepStrictEqual(current.version, receipt.version)) return;
    // Reload paths are Host-resolved absolute paths, unlike Source.path; sourceId
    // and the independently checked current/basis relative paths bind identity.
    result.set(change.targetId, current);
  }
  return result;
}

function sameCurrentBasis(snapshot: Snapshot, event: Event, now: number): boolean {
  const review = event.review!;
  if (!isDeepStrictEqual(snapshot.scope, review.basis.scope) || snapshot.sources.length !== review.basis.sources.length) return false;
  let afterImages: Map<string, Source> | undefined;
  let checkedAfterImages = false;
  return review.basis.sources.every(old => {
    const current = snapshot.sources.find(source => source.sourceId === old.sourceId);
    // Recomputed provenance/candidates are audit metadata, not new authority.
    // Original receipts still bind every source, including acknowledged writes.
    if (!current || current.path !== old.path || current.role !== old.role || current.writable !== old.writable
      || current.sensitivity !== old.sensitivity || !isDeepStrictEqual(current.protectedText, old.protectedText)
      || !isDeepStrictEqual(current.originals ?? [], old.originals ?? [])) return false;
    const tx = event.job.transaction;
    const committedTarget = !!tx && event.job.appliedTransactionIds?.includes(tx.transactionId)
      && Array.isArray(tx.changes) && tx.changes.some(change => change.targetId === old.sourceId);
    // A known committed target cannot fall back to its old pre-commit image,
    // even if a caller supplies a stale snapshot carrying the old version.
    if (!committedTarget && current.content === old.content && isDeepStrictEqual(current.version, old.version)) return true;
    if (!checkedAfterImages) { afterImages = acknowledgedAfterImages(event, snapshot, now); checkedAfterImages = true; }
    return afterImages?.get(old.sourceId) === current;
  });
}

/** No stemming, synonym expansion, model inference, or confidence weighting. Latin
 * words/numbers match whole normalized tokens; CJK runs use adjacent bigrams (a
 * single-character run uses that character). Offsets always address raw content. */
function words(text: string): Word[] {
  const result: Word[] = [];
  const cjk = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u;
  for (const token of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (const part of token[0].matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
      const start = token.index + part.index;
      if (!cjk.test(part[0])) { result.push({ term: normalize(part[0]), start, end: start + part[0].length }); continue; }
      const chars = [...part[0]];
      let offset = start;
      for (let i = 0; i < chars.length; i++) {
        if (chars.length === 1 || i < chars.length - 1) {
          const raw = chars[i] + (chars[i + 1] ?? '');
          result.push({ term: normalize(raw), start: offset, end: offset + raw.length });
        }
        offset += chars[i].length;
      }
    }
  }
  return result;
}

function lexical(text: string, query: Set<string>) {
  const matches = words(text).filter(word => query.has(word.term));
  // A one-character CJK query must still find that literal character in a run;
  // multi-character queries keep their bigrams rather than matching any letter.
  if ([...query].some(term => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(term))) {
    for (const char of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)) {
      if (query.has(normalize(char[0]))) matches.push({ term: normalize(char[0]), start: char.index, end: char.index + char[0].length });
    }
  }
  return { score: query.size ? new Set(matches.map(word => word.term)).size / query.size : 0,
    first: matches.length ? matches.reduce((first, word) => Math.min(first, word.start), Infinity) : 0 };
}

function diagnostic(id: string, event: Event, snapshot: Snapshot, request: RecallRequest, now: number, query: Set<string>, control: ReinforcementControl | undefined, boost: number): ReinforcementDiagnostic {
  const { proposal, review } = event;
  const c = proposal.consolidation!;
  const a = c.applicability;
  const reasons: string[] = [];
  if (!review) reasons.push('not-reviewed');
  else {
    if (review.decision === 'reject') reasons.push('review-rejected');
    if (review.decision === 'defer') reasons.push('review-deferred');
    if (event.job.invalidatedReviewIds?.includes(review.reviewId)) reasons.push('review-invalidated');
    const validReview = authentic(event);
    if (!validReview) reasons.push('invalid-review');
    if (validReview && !sameCurrentBasis(snapshot, event, now)) reasons.push('current-basis-changed');
  }
  if (c.action !== 'reinforce' || proposal.operation !== 'retain' || proposal.before !== proposal.after) reasons.push('not-reinforce');
  if (normalize(a.topic) !== normalize(request.topic)) reasons.push('topic-mismatch');
  if (normalize(a.conditions) !== normalize(request.conditions)) reasons.push('conditions-mismatch');
  if (a.validFrom !== undefined && (!Number.isFinite(timestamp(a.validFrom)) || timestamp(a.validFrom) > now)) reasons.push('not-yet-valid');
  if (a.validUntil !== undefined && (!Number.isFinite(timestamp(a.validUntil)) || timestamp(a.validUntil) < now)) reasons.push('expired');
  const source = snapshot.sources.find(item => item.sourceId === proposal.targetId);
  const start = source && typeof proposal.before === 'string' && proposal.before.trim() ? source.content.indexOf(proposal.before) : -1;
  if (!source) reasons.push('target-unavailable');
  else if (start < 0) reasons.push('fragment-not-current');
  else if (source.content.indexOf(proposal.before, start + 1) >= 0) reasons.push('fragment-not-unique');
  if (typeof proposal.before !== 'string' || lexical(proposal.before, query).score <= 0) reasons.push('no-query-relevance');
  if (control?.enabled === false) reasons.push('control-disabled');
  if (boost === 0) reasons.push('boost-disabled');
  return { candidateId: id, claimKey: c.claimKey, applicability: structuredClone(a), sourceId: proposal.targetId,
    eligible: reasons.length === 0, disabledReasons: reasons, jobId: event.job.jobId, ...(review ? { reviewId: review.reviewId } : {}) };
}

function paragraphs(content: string): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  for (const separator of content.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/gu)) {
    ranges.push({ start, end: separator.index }); start = separator.index + separator[0].length;
  }
  ranges.push({ start, end: content.length });
  return ranges;
}

function trimmed(content: string, range: Range): Range {
  const raw = content.slice(range.start, range.end);
  return { start: range.start + raw.length - raw.trimStart().length, end: range.end - raw.length + raw.trimEnd().length };
}

function subtract(range: Range, excluded: Range[]): Range[] {
  let pieces = [range];
  for (const cut of excluded) pieces = pieces.flatMap(piece => cut.end <= piece.start || cut.start >= piece.end ? [piece]
    : [{ start: piece.start, end: Math.min(piece.end, cut.start) }, { start: Math.max(piece.start, cut.end), end: piece.end }].filter(item => item.end > item.start));
  return pieces;
}

function snippet(content: string, range: Range, firstMatch: number) {
  const fragment = content.slice(range.start, range.end);
  const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
  let start = range.start;
  if (fragmentBytes > MAX_TEXT_BYTES) start += Math.max(0, firstMatch - 128);
  // Never split a surrogate pair, including when selecting the window's start.
  if (start > range.start && /[\uDC00-\uDFFF]/u.test(content[start])) start--;
  let end = start, bytes = 0;
  for (const char of content.slice(start, range.end)) {
    const next = Buffer.byteLength(char, 'utf8');
    if (bytes + next > MAX_TEXT_BYTES) break;
    bytes += next; end += char.length;
  }
  return { text: content.slice(start, end), start, end, textBytes: bytes, fragmentBytes, truncated: start !== range.start || end !== range.end };
}

function sourceVerification(source: Source): RecallHit['sourceVerification'] {
  const receipts = source.originals ?? [];
  return { verified: receipts.filter(item => item.status === 'verified').length,
    unavailable: receipts.filter(item => item.status === 'unavailable').length, invalid: receipts.filter(item => item.status === 'invalid').length,
    independentEvents: 'unknown', meaning: 'original-location-only-not-factual-credibility' };
}

/** Pure local retrieval of current bytes. Scope matching is explicitly NFKC,
 * lowercase, trim and whitespace collapse, followed by exact equality for BOTH
 * required strings; there is no semantic broadening. Time bounds are inclusive.
 * A ranking boost is never factual confidence, new evidence, or context injection. */
export function recallMemory(snapshot: Snapshot, history: Job[], controls: ReinforcementControl[], request: RecallRequest,
  opts: { now?: Date; boost?: number; maxResults?: number; materials?: RecallMaterialCoverage; reinforcementBasis?: Snapshot; aggregate?: boolean; useRelations?: boolean } = {}): RecallResult {
  validateSnapshot(snapshot);
  if (!Array.isArray(history) || !Array.isArray(controls)) throw new TypeError('recall history and controls must be arrays');
  if (!record(request) || ['query', 'topic', 'conditions'].some(key => typeof request[key] !== 'string' || !(request[key] as string).trim())) throw new TypeError('recall requires nonempty query, topic and conditions');
  for (const [name, value] of [['limit', request.limit], ['maxResults', opts.maxResults]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (opts.boost !== undefined && !Number.isFinite(opts.boost)) throw new TypeError('boost must be finite');
  const boost = Math.max(0, Math.min(1, opts.boost ?? DEFAULT_BOOST));
  const limit = Math.min(MAX_RESULTS, opts.maxResults ?? MAX_RESULTS, request.limit ?? 10);
  const now = opts.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  const query = new Set(words(request.query).map(word => word.term));
  const past = historicalEvents(history, snapshot.scope, now.getTime());
  const control = latestControls(controls, snapshot.scope, now.getTime());
  // An optional historical lookup must not restore an approval whose regular
  // current basis has changed (including daily rollover). More recall ≠ authority.
  const basis = opts.reinforcementBasis ?? snapshot;
  validateSnapshot(basis);
  if (!isDeepStrictEqual(basis.scope, snapshot.scope)) throw new TypeError('Recall reinforcement basis scope mismatch');
  if (basis.sources.some(source => !isDeepStrictEqual(snapshot.sources.find(s => s.sourceId === source.sourceId), source))) throw new TypeError('Recall current basis differs from returned source bytes');
  const diagnostics = [...past.events].map(([id, event]) => diagnostic(id, event, basis, request, now.getTime(), query, control.latest.get(id), boost));
  const hits: RecallHit[] = [];
  for (const source of snapshot.sources) {
    const candidates = diagnostics.filter(item => item.sourceId === source.sourceId).map(item => {
      const event = past.events.get(item.candidateId)!;
      const text = event.proposal.before;
      const start = typeof text === 'string' && text.trim() ? source.content.indexOf(text) : -1;
      return { item, event, start, end: start + (typeof text === 'string' ? text.length : 0) };
    }).filter(range => range.start >= 0 && source.content.indexOf(range.event.proposal.before, range.start + 1) < 0
      && lexical(range.event.proposal.before, query).score > 0)
      .sort((a, b) => Number(b.item.eligible) - Number(a.item.eligible) || (newer(a.event, b.event) ? -1 : newer(b.event, a.event) ? 1 : 0)
        || (b.end - b.start) - (a.end - a.start) || compare(a.item.candidateId, b.item.candidateId));
    const selected: typeof candidates = [];
    for (const range of candidates) if (!selected.some(other => range.start < other.end && range.end > other.start)) selected.push(range);
    const ranges: (Range & { item?: ReinforcementDiagnostic })[] = [...selected,
      ...paragraphs(source.content).flatMap(range => subtract(range, selected)).map(range => trimmed(source.content, range)).filter(range => range.end > range.start)];
    const hash = createHash('sha256').update(source.content).digest('hex');
    for (const range of ranges) {
      const relevance = lexical(source.content.slice(range.start, range.end), query);
      if (relevance.score <= 0) continue;
      const excerpt = snippet(source.content, range, relevance.first);
      const reinforcementBoost = range.item?.eligible ? boost : 0;
      hits.push({ sourceId: source.sourceId, path: source.path, sourceRole: source.role, sensitivity: source.sensitivity,
        temporalStatus: source.role === 'daily' ? 'dated-record-not-current-status' : 'current-file-not-independent-truth', version: structuredClone(source.version), text: excerpt.text,
        score: relevance.score + reinforcementBoost, baseScore: relevance.score, reinforcementBoost,
        ...(range.item ? { candidateId: range.item.candidateId, applicability: structuredClone(range.item.applicability), reinforcement: {
          eligible: range.item.eligible, disabledReasons: [...range.item.disabledReasons], ...(range.item.reviewId ? { reviewId: range.item.reviewId } : {}) } } : {}),
        sourceVerification: sourceVerification(source), proof: { kind: 'current-source', contentHash: hash,
          start: excerpt.start, end: excerpt.end, fragmentStart: range.start, fragmentEnd: range.end, offsetUnit: 'utf16-code-units',
          textBytes: excerpt.textBytes, fragmentBytes: excerpt.fragmentBytes, truncated: excerpt.truncated } });
    }
  }
  const lexicalMatches = hits.length;
  const linked = opts.useRelations === false ? undefined : recallRelations(snapshot, history, now);
  const activeRelations: RecallRelation[] = [];
  const relationStrength = new Map<string, number>();
  const initialBestLexicalScore = hits.reduce((best, hit) => Math.max(best, hit.baseScore), 0);
  const overlaps = (hit: RecallHit, endpoint: RecallRelation['after']) => hit.sourceId === endpoint.sourceId
    && hit.proof.start < endpoint.proof.end && hit.proof.end > endpoint.proof.start;
  for (const relation of linked?.relations ?? []) {
    const afterScore = lexical(relation.after.text, query);
    const strength = Math.max(afterScore.score, lexical(relation.previous.text, query).score, ...relation.evidence.map(ep => lexical(ep.text, query).score));
    // A shared name or incidental word must not reserve unrelated corrections
    // ahead of a direct answer, even when topic/conditions happen to match.
    if (strength <= 0 || strength < initialBestLexicalScore * 0.5) continue;
    activeRelations.push(relation);
    relationStrength.set(relation.relationId, strength);
    let canonical = hits.find(hit => hit.sourceId === relation.after.sourceId && hit.proof.start === relation.after.proof.start && hit.proof.end === relation.after.proof.end);
    if (!canonical) {
      const source = snapshot.sources.find(s => s.sourceId === relation.after.sourceId)!;
      const range = { start: relation.after.proof.start, end: relation.after.proof.end };
      const excerpt = snippet(source.content, range, afterScore.first);
      canonical = { sourceId: source.sourceId, path: source.path, sourceRole: source.role, sensitivity: source.sensitivity,
        temporalStatus: source.role === 'daily' ? 'dated-record-not-current-status' : 'current-file-not-independent-truth', version: structuredClone(source.version),
        text: excerpt.text, score: afterScore.score, baseScore: afterScore.score, reinforcementBoost: 0,
        sourceVerification: sourceVerification(source), retrievalReason: 'linked-reviewed-after-image',
        proof: { kind: 'current-source', contentHash: relation.after.proof.contentHash, start: excerpt.start, end: excerpt.end,
          fragmentStart: range.start, fragmentEnd: range.end, offsetUnit: 'utf16-code-units', textBytes: excerpt.textBytes, fragmentBytes: excerpt.fragmentBytes, truncated: excerpt.truncated } };
      hits.push(canonical);
    }
    const a = relation.applicability;
    const inTime = (a.validFrom === undefined || timestamp(a.validFrom) <= now.getTime()) && (a.validUntil === undefined || timestamp(a.validUntil) >= now.getTime());
    const applicabilityMatch = !inTime ? 'out-of-time' : normalize(a.topic) === normalize(request.topic) && normalize(a.conditions) === normalize(request.conditions) ? 'exact-request' : 'different-request-scope';
    canonical.consolidation = { relationId: relation.relationId, role: 'current-after-image', action: relation.kind === 'reviewed-merge' ? 'merge' : 'correct', applicabilityMatch, meaning: 'reviewed-operation-not-independent-truth' };
    for (const hit of hits) if (hit !== canonical && hit.consolidation?.role !== 'current-after-image' && relation.evidence.some(endpoint => overlaps(hit, endpoint))) hit.consolidation = {
      relationId: relation.relationId, role: 'historical-evidence', action: relation.kind === 'reviewed-merge' ? 'merge' : 'correct', applicabilityMatch, meaning: 'reviewed-operation-not-independent-truth' };
  }
  const order = (a: RecallHit, b: RecallHit) => b.score - a.score || b.baseScore - a.baseScore || compare(a.sourceId, b.sourceId) || compare(a.path, b.path) || a.proof.fragmentStart - b.proof.fragmentStart;
  hits.sort(order);
  const canonicalHits = hits.filter(hit => hit.consolidation?.role === 'current-after-image');
  const grouped = opts.aggregate === false ? undefined : groupRecallHits(hits.filter(hit => hit.consolidation?.role !== 'current-after-image'), snapshot);
  const candidates = grouped ? [...canonicalHits, ...grouped.hits] : hits;
  if (grouped) { grouped.coverage.inputHits += canonicalHits.length; grouped.coverage.groups += canonicalHits.length; grouped.coverage.memberLocations += canonicalHits.length; }
  // Reserve an in-time reviewed after-image as a scoped historical link, not
  // a request-wide conclusion. Cross-scope links keep raw evidence visible;
  // only exact request scope can fold its fully covered evidence fragments.
  // No numeric truth boost or new write approval is created.
  const collapsedEvidence = new Set<RecallHit>();
  for (const relation of activeRelations) {
    const hasCanonical = candidates.some(hit => hit.consolidation?.relationId === relation.relationId && hit.consolidation.role === 'current-after-image' && hit.consolidation.applicabilityMatch === 'exact-request');
    if (!hasCanonical) continue;
    // Suppress only whole returned fragments contained by reviewed evidence. A
    // neighboring or partly overlapping event must keep its own result slot.
    for (const hit of candidates) {
      if (hit.consolidation?.relationId !== relation.relationId || hit.consolidation.role !== 'historical-evidence') continue;
      const locations = hit.group ? hit.group.members : [{ sourceId: hit.sourceId, proof: hit.proof }];
      if (hit.group && (hit.group.omittedMembers > 0 || hit.group.memberCount !== hit.group.members.length)) continue;
      if (locations.length > 0 && locations.every(member => relation.evidence.some(ep => member.sourceId === ep.sourceId && member.proof.fragmentStart >= ep.proof.start && member.proof.fragmentEnd <= ep.proof.end))) collapsedEvidence.add(hit);
    }
  }
  const presented = candidates.filter(hit => !collapsedEvidence.has(hit));
  const bestLexicalScore = hits.reduce((best, hit) => Math.max(best, hit.baseScore), 0);
  const reserved = (hit: RecallHit) => hit.consolidation?.role === 'current-after-image' && hit.consolidation.applicabilityMatch !== 'out-of-time'
    && (hit.consolidation.applicabilityMatch === 'exact-request' || (hit.baseScore > 0 && hit.baseScore >= bestLexicalScore * 0.5));
  presented.sort((a, b) => Number(reserved(b)) - Number(reserved(a)) || order(a, b));
  diagnostics.sort((a, b) => Number(b.eligible) - Number(a.eligible) || compare(a.candidateId, b.candidateId));
  const returned = presented.slice(0, limit);
  const visibleIds = new Set(returned.flatMap(hit => hit.consolidation ? [hit.consolidation.relationId] : []));
  const returnedRelations = activeRelations.filter(r => visibleIds.has(r.relationId) && ((relationStrength.get(r.relationId) ?? 0) >= bestLexicalScore * 0.5
    || returned.some(hit => hit.consolidation?.relationId === r.relationId && hit.consolidation.applicabilityMatch === 'exact-request')));
  const availableRelationIds = new Set(returnedRelations.map(r => r.relationId));
  const visible = returned.filter(hit => !hit.consolidation || availableRelationIds.has(hit.consolidation.relationId) || hit.consolidation.role !== 'current-after-image');
  for (const hit of visible) if (hit.consolidation && !availableRelationIds.has(hit.consolidation.relationId)) delete hit.consolidation;
  if (linked) { linked.coverage.omitted += linked.relations.length - returnedRelations.length; linked.coverage.returned = returnedRelations.length; }
  return boundResult({ hits: visible, ...(linked ? { relations: returnedRelations } : {}), coverage: { snapshotId: snapshot.snapshotId, sourcesScanned: snapshot.sources.length, queryTerms: query.size,
    lexicalMatches, returnedHits: visible.length, resultsTruncated: presented.length > limit || visible.length < returned.length,
    snippetsTruncated: visible.filter(hit => hit.proof.truncated).length, historyJobsConsidered: past.considered,
    historyJobsIgnored: past.ignored, controlsIgnored: control.ignored,
    ...(snapshot.originalCoverage ? { originalCoverage: structuredClone(snapshot.originalCoverage) } : {}),
    ...(opts.materials ? { materials: structuredClone(opts.materials) } : {}),
    ...(grouped ? { grouping: grouped.coverage } : {}),
    ...(linked ? { relations: linked.coverage } : {}),
    reinforcement: { items: diagnostics.slice(0, MAX_DIAGNOSTICS), total: diagnostics.length, truncated: diagnostics.length > MAX_DIAGNOSTICS },
    byteBudget: { maxBytes: MAX_OUTPUT_BYTES, outputBytes: 0, omittedHits: 0, omittedDiagnostics: 0, omittedMetadata: [] } },
  policy: { retrieval: 'distinct matching normalized lexical query terms / query terms; current paragraphs and exact retained fragments; no semantic expansion. Exact normalized full-fragment display grouping is not event identity. Current applied reviewed merge/correction after-images may be linked/reserved with their original evidence; relation links and ranking are not truth.',
    applicability: 'exact NFKC + lowercase + trim + collapsed whitespace equality of both topic and conditions; no synonym, subset or contextual inference; inclusive time bounds',
    freshness: 'latest recorded same-candidate decision only; complete current source set, paths, raw bytes, versions and original receipts; only exact approved same-job after-images with acknowledged reload may replace reviewed bytes/versions; no arbitrary rebase or fallback',
    reinforcement: 'additive bounded non-stacking retrieval priority, not factual confidence; enable control cannot create evidence',
    sourceVerification: 'original-location receipts and unknown provenance never multiply relevance or factual credibility; independent events remain unknown',
    normalizedRequest: { topic: normalize(request.topic), conditions: normalize(request.conditions) }, now: now.toISOString(),
    configuredBoost: boost, maxTextBytes: MAX_TEXT_BYTES, maxResults: limit } });
}
