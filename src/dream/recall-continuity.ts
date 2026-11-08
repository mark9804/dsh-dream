import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { applyProposal, validateChangeSet, validateJob } from '../domain/contracts.js';
import { protectedText } from './materials.js';
import type { ChangeSet, Job, Proposal, ReloadSource, Review, Snapshot, Source } from '../types.js';

const MAX_TRANSACTIONS = 256;
const MAX_HOPS = 64;
const at = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : NaN;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export interface ContinuityCoverage { considered: number; authenticated: number; omitted: number; invalid: number; maxTransactions: number; maxHops: number; searchSteps: number; maxSearchSteps: number; searchBudgetExhausted: boolean }
export interface ContinuityRange { start: number; end: number; dependencies?: { start: number; end: number }[] }
export interface ContinuedEndpoint { source: Source; range: ContinuityRange; transactionIds: string[] }
interface Receipt { transactionId: string; status?: string; sources?: ReloadSource[]; acknowledgedAt?: string }
export interface AppliedRecord { job: Job; transaction: ChangeSet; reload: Receipt; basis: Snapshot; time: number; strict: boolean; changes: { before: Source; after: Source; proposals: Proposal[] }[] }
export function reviewSnapshot(review: Review): Snapshot {
  return { schemaVersion: 1, snapshotId: review.reviewId, capturedAt: review.reviewedAt, scope: review.basis.scope,
    sources: review.basis.sources, ...(review.basis.candidates ? { candidates: review.basis.candidates } : {}),
    ...(review.basis.originalCoverage ? { originalCoverage: review.basis.originalCoverage } : {}) };
}
export function sameSourceShape(left: Source, right: Source): boolean {
  return left.sourceId === right.sourceId && left.path === right.path && left.role === right.role && left.writable === right.writable
    && left.sensitivity === right.sensitivity && isDeepStrictEqual(left.protectedText, right.protectedText)
    && isDeepStrictEqual(left.originals ?? [], right.originals ?? []);
}
function sameState(left: Source, right: Source): boolean {
  return left.content === right.content && isDeepStrictEqual(left.version, right.version) && sameSourceShape(left, right);
}
/** Move only through the exact sequence of approved local edits. A touch followed
 * by restoration is STILL a touch; no net diff, fuzzy matching or timestamps can
 * establish that a historical claim survived. */
function moveRange(content: string, proposals: Proposal[], initial: ContinuityRange): ContinuityRange | undefined {
  let range = { ...initial, dependencies: initial.dependencies?.map(span => ({ ...span })) };
  const originalContext = initial.dependencies?.length ? [{ start: initial.start, end: initial.end }, ...initial.dependencies].map(span => contextRanges(content, span).map(context => content.slice(context.start, context.end).trimEnd())) : undefined;
  for (const proposal of proposals) {
    const start = proposal.operation === 'append' ? content.length : content.indexOf(proposal.before);
    const end = start + (proposal.operation === 'append' ? 0 : proposal.before.length);
    const spans = [{ start: range.start, end: range.end }, ...(range.dependencies ?? [])];
    if (start < 0 || spans.some(span => (start < span.end && end > span.start) || (start === end && start > span.start && start < span.end))) return;
    // Inserting adjacent negation/qualification changes context without touching
    // endpoint bytes. Only a blank-line-separated append is safely unrelated.
    if (start === end && spans.some(span => start === span.start || start === span.end)
      && !(start === content.length && /\n\s*\n/u.test(content.slice(-2) + proposal.after.slice(0, 2)))) return;
    const delta = proposal.after.length - (end - start);
    const moved = spans.map(span => end <= span.start ? { start: span.start + delta, end: span.end + delta } : span);
    range = { ...moved[0], dependencies: moved.slice(1) };
    content = applyProposal(content, proposal);
    if (originalContext && !isDeepStrictEqual([{ start: range.start, end: range.end }, ...(range.dependencies ?? [])].map(span => contextRanges(content, span).map(context => content.slice(context.start, context.end).trimEnd())), originalContext)) return;
  }
  return range;
}
function contextRanges(content: string, range: ContinuityRange): { start: number; end: number }[] {
  let semanticEnd = range.end;
  while (semanticEnd > range.start && /\s/u.test(content[semanticEnd - 1])) semanticEnd--;
  const start = content.lastIndexOf('\n\n', range.start), end = content.indexOf('\n\n', semanticEnd);
  const spans = [{ start: start < 0 ? 0 : start + 2, end: end < 0 ? content.length : end }];
  const headings: { level: number; start: number; end: number }[] = [];
  const declarations = [
    ...[...content.matchAll(/^[ \t]{0,3}(#{1,6})[ \t]+.+$/gm)].map(match => ({ level: match[1].length, start: match.index, end: match.index + match[0].length })),
    ...[...content.matchAll(/^[ \t]{0,3}[^\n]+\n[ \t]{0,3}(={2,}|-{2,})[ \t]*$/gm)].map(match => ({ level: match[1][0] === '=' ? 1 : 2, start: match.index, end: match.index + match[0].length })),
  ].sort((a, b) => a.start - b.start);
  for (const heading of declarations) {
    if (heading.start >= range.start) break;
    while (headings.length && headings.at(-1)!.level >= heading.level) headings.pop();
    headings.push(heading);
  }
  return [...spans, ...headings.map(({ start, end }) => ({ start, end }))];
}
function originalRange(record: AppliedRecord, proposal: Proposal): ContinuityRange | undefined {
  const change = record.changes.find(c => c.before.sourceId === proposal.targetId); if (!change) return;
  let content = change.before.content, range: ContinuityRange | undefined;
  const originalStart = content.indexOf(proposal.before);
  if (originalStart < 0) return;
  const originalContext = contextRanges(content, { start: originalStart, end: originalStart + proposal.before.length }).map(span => content.slice(span.start, span.end).trimEnd());
  const extraQuotes = proposal.evidence.filter(e => e.sourceId === proposal.targetId && !proposal.before.includes(e.quote));
  const originalDependencies = contextRanges(content, { start: originalStart, end: originalStart + proposal.before.length });
  for (const { quote } of extraQuotes) {
    const start = content.indexOf(quote); if (start < 0 || content.indexOf(quote, start + 1) >= 0) return;
    originalDependencies.push({ start, end: start + quote.length }, ...contextRanges(content, { start, end: start + quote.length }));
  }
  let beforeGuard: ContinuityRange = { start: originalStart, end: originalStart + proposal.before.length, dependencies: originalDependencies };
  for (const edit of change.proposals) {
    if (edit.proposalId === proposal.proposalId) {
      const start = content.indexOf(edit.before); if (start < 0) return;
      if (!isDeepStrictEqual(contextRanges(content, { start, end: start + edit.before.length }).map(span => content.slice(span.start, span.end).trimEnd()), originalContext)) return;
      // A target quote outside before is an additional historical dependency.
      // It cannot be silently discarded just because it lives in the target.
      const dependencies: { start: number; end: number }[] = [];
      for (const { quote } of extraQuotes) {
        const position = content.indexOf(quote); if (position < 0 || content.indexOf(quote, position + 1) >= 0) return;
        const moved = moveRange(content, [edit], { start: position, end: position + quote.length }); if (!moved) return;
        dependencies.push({ start: moved.start, end: moved.end }, ...contextRanges(applyProposal(content, edit), moved));
      }
      content = applyProposal(content, edit);
      range = { start, end: start + edit.after.length, dependencies: [...dependencies, ...contextRanges(content, { start, end: start + edit.after.length })] };
      continue;
    }
    if (range) { range = moveRange(content, [edit], range); if (!range) return; }
    else { const moved = moveRange(content, [edit], beforeGuard); if (!moved) return; beforeGuard = moved; }
    content = applyProposal(content, edit);
  }
  if (!range || content.slice(range.start, range.end) !== proposal.after) return;
  return range;
}

/** Read-only catalog of acknowledged transactions, including legacy current-slot
 * records. It never provides commit/reinforcement authority or reads cached text
 * in place of a current source. Every edge is the complete reconstructed approved
 * plan; all siblings must also reach an exact current state. */
export function createRecallContinuity(snapshot: Snapshot, history: Job[], now: Date) {
  const coverage: ContinuityCoverage = { considered: 0, authenticated: 0, omitted: 0, invalid: 0, maxTransactions: MAX_TRANSACTIONS, maxHops: MAX_HOPS, searchSteps: 0, maxSearchSteps: 8192, searchBudgetExhausted: false };
  const candidates: { job: Job; transaction: ChangeSet; reload: Receipt; writtenSources?: ReloadSource[] }[] = [];
  for (const job of history) {
    if (!job || !isDeepStrictEqual(job.scope, snapshot.scope)) continue;
    try { validateJob(job); } catch (error) { if (error instanceof TypeError) { coverage.invalid++; continue; } throw error; }
    for (const entry of job.transactionHistory ?? []) candidates.push({ job, transaction: entry.transaction, reload: entry.reload, writtenSources: entry.writtenSources });
    if (job.transaction && job.reload?.acknowledgedAt && !job.transactionHistory?.some(entry => entry.transaction.transactionId === job.transaction!.transactionId)) candidates.push({ job, transaction: job.transaction, reload: job.reload, writtenSources: job.transactionWriteReceipt?.transactionId === job.transaction.transactionId ? job.transactionWriteReceipt.sources : undefined });
  }
  candidates.sort((a, b) => (at(b.reload.acknowledgedAt) || Infinity) - (at(a.reload.acknowledgedAt) || Infinity) || compare(a.transaction.transactionId, b.transaction.transactionId));
  const identities = new Map<string, { jobId: string; transaction: ChangeSet; reload: Receipt; writtenSources?: ReloadSource[] }>(), conflicts = new Set<string>();
  for (const item of candidates) {
    const key = item.transaction.transactionId, prior = identities.get(key);
    const value = { jobId: item.job.jobId, transaction: { ...item.transaction, status: 'applied' as const }, reload: item.reload, writtenSources: item.writtenSources };
    if (prior && !isDeepStrictEqual(prior, value)) conflicts.add(key); else identities.set(key, value);
  }
  const records: AppliedRecord[] = [], seen = new Set<string>();
  const blocked: { sourceId: string; content: string; version: Source['version'] }[] = [];
  const block = (item: typeof candidates[number]) => { for (const change of item.transaction.changes ?? []) if (!change.targetId.startsWith('archive:')) blocked.push({ sourceId: change.targetId, content: change.before, version: change.version }); };
  for (const item of candidates) {
    const { job, transaction: tx, reload } = item; const identity = tx.transactionId;
    if (seen.has(identity)) continue; seen.add(identity); coverage.considered++;
    if (records.length >= MAX_TRANSACTIONS) { coverage.omitted++; block(item); continue; }
    try {
      if (conflicts.has(identity) || !job.appliedTransactionIds?.includes(identity) || !tx.proposalIds.every(id => job.appliedProposalIds.includes(id))
        || reload.transactionId !== identity || reload.status !== 'ready' || !Array.isArray(reload.sources)
        || new Set(reload.sources.map(s => s.sourceId)).size !== reload.sources.length || !Number.isFinite(at(reload.acknowledgedAt)) || at(reload.acknowledgedAt) > now.getTime()) throw new TypeError('Unacknowledged transaction');
      const first = job.reviews.find(r => r.reviewId === tx.reviewIds[0]); if (!first) throw new TypeError('Missing frozen review');
      const basis = reviewSnapshot(first);
      validateChangeSet({ ...tx, status: 'prepared' }, { ...job, transactionHistory: undefined, snapshot: basis, state: 'prepared', committingProposalIds: [...tx.proposalIds], appliedProposalIds: job.appliedProposalIds.filter(id => !tx.proposalIds.includes(id)) });
      for (const id of tx.reviewIds) {
        const review = job.reviews.find(r => r.reviewId === id);
        if (!review || !Number.isFinite(at(review.reviewedAt)) || at(review.reviewedAt) > at(reload.acknowledgedAt)) throw new TypeError('Acknowledgment predates review');
      }
      const writtenSources = item.writtenSources;
      const strict = Array.isArray(writtenSources) && writtenSources.length === tx.changes.length && new Set(writtenSources.map(s => s.sourceId)).size === writtenSources.length;
      if (writtenSources && !strict) throw new TypeError('Incomplete write receipts');
      const changes: AppliedRecord['changes'] = [];
      for (const change of tx.changes) {
        if (change.targetId.startsWith('archive:')) continue;
        const before = basis.sources.find(s => s.sourceId === change.targetId), receipt = reload.sources.find(s => s.sourceId === change.targetId);
        if (!before || !receipt || receipt.content !== change.after || before.content !== change.before || !isDeepStrictEqual(before.version, change.version)) throw new TypeError('Missing exact before/after receipt');
        if (strict) { const written = writtenSources.find(s => s.sourceId === change.targetId); if (!written || written.path !== receipt.path || written.content !== change.after || !isDeepStrictEqual(written.version, receipt.version)) throw new TypeError('Reload differs from actual write receipt'); }
        changes.push({ before, after: { ...before, content: change.after, version: receipt.version, protectedText: protectedText(change.after, before.role), sensitivity: /<!--\s*sensitive\s*-->/i.test(change.after) ? 'sensitive' : before.sensitivity }, proposals: tx.proposalIds.map(id => job.proposals.find(p => p.proposalId === id)!).filter(p => p.targetId === change.targetId) });
      }
      if (!changes.length) throw new TypeError('No current-source change');
      records.push({ job, transaction: tx, reload, basis, time: at(reload.acknowledgedAt), strict, changes }); coverage.authenticated++;
    } catch (error) { if (error instanceof TypeError) { coverage.invalid++; block(item); } else throw error; }
  }
  const bySource = new Map<string, AppliedRecord[]>();
  for (const record of records) for (const change of record.changes) { const list = bySource.get(change.before.sourceId) ?? []; list.push(record); bySource.set(change.before.sourceId, list); }
  function follow(origin: AppliedRecord, source: Source, anchor?: ContinuityRange): { source: Source; range?: ContinuityRange; route: AppliedRecord[] } | undefined {
    let current = source, time = origin.time, range = anchor && { ...anchor };
    const visited = new Set([origin.transaction.transactionId]), route: AppliedRecord[] = [];
    for (let depth = 0; depth <= MAX_HOPS; depth++) {
      if (++coverage.searchSteps > coverage.maxSearchSteps) { coverage.searchBudgetExhausted = true; return; }
      if (blocked.some(old => old.sourceId === current.sourceId && old.content === current.content && isDeepStrictEqual(old.version, current.version))) return;
      const next = (bySource.get(source.sourceId) ?? []).filter(record => !visited.has(record.transaction.transactionId) && record.changes.some(change => sameState(change.before, current)));
      // A recorded successor cannot be ignored merely because an old snapshot or
      // a rollback currently resembles this intermediate after-image.
      if (!next.length) { const actual = snapshot.sources.find(s => s.sourceId === source.sourceId); return actual && sameState(current, actual) ? { source: actual, ...(range ? { range } : {}), route } : undefined; }
      if (!origin.strict || next.length !== 1 || !next[0].strict || next[0].time < time || depth === MAX_HOPS) return;
      const record = next[0], change = record.changes.find(c => c.before.sourceId === source.sourceId)!;
      if (range) { range = moveRange(current.content, change.proposals, range); if (!range) return; }
      current = change.after; time = record.time; visited.add(record.transaction.transactionId); route.push(record);
    }
    return;
  }
  const valid = new Map<AppliedRecord, boolean>(), checking = new Set<AppliedRecord>();
  function currentTransaction(record: AppliedRecord): boolean {
    const cached = valid.get(record); if (cached !== undefined) return cached;
    if (checking.has(record)) return false; checking.add(record);
    let ok = true;
    for (const change of record.changes) {
      const path = follow(record, change.after);
      if (!path || path.route.some(next => !currentTransaction(next))) { ok = false; break; }
    }
    checking.delete(record); valid.set(record, ok); return ok;
  }
  return {
    coverage,
    find(jobId: string, proposalId: string, reviewId: string): AppliedRecord | undefined {
      return records.find(record => record.job.jobId === jobId && record.transaction.proposalIds.some((id, index) => id === proposalId && record.transaction.reviewIds[index] === reviewId));
    },
    endpoint(record: AppliedRecord, proposal: Proposal): ContinuedEndpoint | undefined {
      if (!currentTransaction(record)) return;
      const range = originalRange(record, proposal), source = record.changes.find(c => c.before.sourceId === proposal.targetId)?.after;
      if (!range || !source) return;
      const path = follow(record, source, range); if (!path?.range || path.source.content.slice(path.range.start, path.range.end) !== proposal.after) return;
      return { source: path.source, range: path.range, transactionIds: path.route.map(r => r.transaction.transactionId) };
    },
    /** Stable audit identity over the actual chain, not an approval digest. */
    chainHash(transactionIds: string[]): string { return hash(JSON.stringify(transactionIds)); },
  };
}
