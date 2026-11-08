import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { Applicability, Candidate, CandidateView, Consolidation, EvidenceLineage, Job, Proposal, Provenance, Scope, Snapshot, Source } from '../types.js';

type Span = NonNullable<Provenance['spans']>[number];
type Match = Span & { start: number; end: number };
const MAX_DEPTH = 64;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const unique = (values: string[]) => [...new Set(values)].sort();
const artifactId = (scope: Scope, source: Source) => hash(JSON.stringify([scope.memoryRootId, source.path]));
const emptyLineage = (): EvidenceLineage => ({ policyVersion: 1, rootIds: [], derivedFrom: [], independentEvents: 'unknown' });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

/** Structural validation is not authentication: only the Host's stored history is authoritative. */
export function isEvidenceLineage(value: unknown): value is EvidenceLineage {
  return record(value) && value.policyVersion === 1 && value.independentEvents === 'unknown'
    && strings(value.rootIds) && strings(value.derivedFrom);
}

function isSpan(value: unknown): value is Span {
  return record(value) && typeof value.text === 'string' && value.text.length > 0
    && strings(value.rootIds) && strings(value.derivedFrom);
}

/** Bind Host-supplied annotations to exactly this source, not a later edit or another path. */
export function hasBoundProvenance(source: Source, scope: Scope): source is Source & { provenance: Provenance } {
  const p = source.provenance;
  if (!p || p.schemaVersion !== 1 || p.independentEvents !== 'unknown'
    || !['file-artifact', 'derived', 'mixed'].includes(p.kind)
    || p.artifactId !== artifactId(scope, source) || p.contentHash !== hash(source.content)
    || !strings(p.rootIds) || !strings(p.derivedFrom)) return false;
  // Old source-wide derived annotations cannot safely classify quotes in a mixed file.
  if (!Array.isArray(p.spans)) return p.kind === 'file-artifact' && p.derivedFrom.length === 0;
  if (!p.spans.every(isSpan) || p.spans.map(span => span.text).join('') !== source.content) return false;
  if (source.content.length === 0) return p.kind === 'file-artifact' && p.derivedFrom.length === 0;
  return isDeepStrictEqual(unique(p.spans.flatMap(span => span.rootIds)), unique(p.rootIds))
    && isDeepStrictEqual(unique(p.spans.flatMap(span => span.derivedFrom)), unique(p.derivedFrom));
}

// Sorted object keys make ids independent of JSON property insertion order; undefined
// stays distinguishable from an absent optional property (exact applicability).
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

export function candidateId(consolidation: Consolidation, scope: Scope): string {
  return `candidate-${hash(canonical({ scope, claimKey: consolidation.claimKey, applicability: consolidation.applicability }))}`;
}

function usableSource(source: Source): boolean {
  return record(source) && typeof source.sourceId === 'string' && typeof source.path === 'string' && typeof source.content === 'string';
}

function usableSnapshot(snapshot: Snapshot | undefined, scope: Scope): snapshot is Snapshot {
  return !!snapshot && isDeepStrictEqual(snapshot.scope, scope) && Array.isArray(snapshot.sources) && snapshot.sources.every(usableSource);
}

function scopedHistory(history: Job[], scope: Scope): Job[] {
  return history.filter(job => record(job) && isDeepStrictEqual(job.scope, scope)
    && (!job.snapshot || isDeepStrictEqual(job.snapshot.scope, scope)))
    .slice().sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.jobId, b.jobId) || compare(a.updatedAt, b.updatedAt));
}

function compare(a: string | undefined, b: string | undefined): number {
  const left = a ?? '', right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function applied(job: Job, proposal: Proposal): boolean {
  return Array.isArray(job.appliedProposalIds) && job.appliedProposalIds.includes(proposal.proposalId);
}

function accepted(job: Job, proposal: Proposal): boolean {
  return Array.isArray(job.reviews) && job.reviews.some(review => review.proposalId === proposal.proposalId
    && review.jobId === job.jobId && review.decision === 'accept' && !job.invalidatedReviewIds?.includes(review.reviewId));
}

/** One in-memory resolver; never reads files or creates a separate metadata registry. */
class Resolver {
  readonly jobs: Job[];
  private readonly parents = new Map<string, string>();
  private readonly rank = new Map<string, number>();
  private readonly cache = new Map<Proposal, EvidenceLineage>();
  private readonly visiting = new Set<Proposal>();
  private readonly imageCache = new Map<number, { content: string; spans: Span[] }[]>();
  private readonly imageVisiting = new Set<number>();

  constructor(readonly scope: Scope, history: Job[], current?: Snapshot) {
    this.jobs = scopedHistory(history, scope);
    const snapshots = this.jobs.flatMap(job => usableSnapshot(job.snapshot, scope) ? [job.snapshot] : []);
    if (current) snapshots.push(current);
    const copies = new Map<string, string>();
    // Earlier historical artifacts win over newly added copies; same-batch ties use
    // artifact ids, not iteration order. Revisions of one path keep one identity.
    snapshots.forEach((snapshot, index) => {
      for (const source of [...snapshot.sources].sort((a, b) => compare(artifactId(scope, a), artifactId(scope, b)))) {
        const id = artifactId(scope, source);
        if (!this.parents.has(id)) { this.parents.set(id, id); this.rank.set(id, index); }
        if (!source.content.trim()) continue;
        const content = hash(source.content);
        const prior = copies.get(content);
        if (prior) this.union(id, prior);
        else copies.set(content, id);
      }
    });
  }

  root(id: string): string {
    let root = id;
    while (this.parents.has(root) && this.parents.get(root) !== root) root = this.parents.get(root)!;
    let next = id;
    while (this.parents.has(next) && this.parents.get(next) !== root) {
      const parent = this.parents.get(next)!;
      this.parents.set(next, root);
      next = parent;
    }
    return root;
  }

  private union(a: string, b: string): void {
    const left = this.root(a), right = this.root(b);
    if (left === right) return;
    const order = (this.rank.get(left)! - this.rank.get(right)!) || compare(left, right);
    this.parents.set(order < 0 ? right : left, order < 0 ? left : right);
  }

  private normalize(lineage: EvidenceLineage): EvidenceLineage {
    return { policyVersion: 1, rootIds: unique(lineage.rootIds.map(id => this.root(id))),
      derivedFrom: unique(lineage.derivedFrom), independentEvents: 'unknown' };
  }

  proposal(proposal: Proposal, index: number, depth = 0): EvidenceLineage {
    const cached = this.cache.get(proposal);
    if (cached) return cached;
    const job = this.jobs[index];
    if (!job || depth >= MAX_DEPTH || this.visiting.has(proposal)) return emptyLineage();
    this.visiting.add(proposal);
    try {
      let lineage: EvidenceLineage;
      // New model proposals never enter here: these are approved/applied records in
      // Host-owned jobs. Pending self-supplied metadata is deliberately ignored.
      if ((applied(job, proposal) || accepted(job, proposal)) && isEvidenceLineage(proposal.lineage)) {
        lineage = this.normalize(proposal.lineage);
      } else if (usableSnapshot(job.snapshot, this.scope)) {
        lineage = evidenceLineage(proposal, this.annotate(job.snapshot, index, depth + 1));
      } else {
        lineage = emptyLineage(); // Incomplete legacy history cannot mint an origin.
      }
      this.cache.set(proposal, lineage);
      return lineage;
    } finally {
      this.visiting.delete(proposal);
    }
  }

  /** Replay only recorded applied edits over annotated snapshots. A local edit must
   * not turn the untouched portion of an older generated sentence into a root. */
  private afterImages(index: number, depth: number): { content: string; spans: Span[] }[] {
    const cached = this.imageCache.get(index);
    if (cached) return cached;
    const job = this.jobs[index];
    if (depth >= MAX_DEPTH || this.imageVisiting.has(index) || !usableSnapshot(job.snapshot, this.scope)) return [];
    const proposals = Array.isArray(job.proposals) ? job.proposals : [];
    const ordered = uniqueApplied(job).map(id => proposals.find(proposal => proposal.proposalId === id))
      .filter((proposal): proposal is Proposal => !!proposal && proposal.operation !== 'retain');
    if (!ordered.length) return [];
    this.imageVisiting.add(index);
    try {
      const annotated = this.annotate(job.snapshot, index, depth + 1);
      const targets = new Map<string, Span[]>();
      const invalid = new Set<string>();
      for (const proposal of ordered) {
        if (invalid.has(proposal.targetId)) continue;
        const target = annotated.sources.find(source => source.sourceId === proposal.targetId);
        if (!target?.provenance?.spans || typeof proposal.after !== 'string') continue;
        const spans = targets.get(proposal.targetId) ?? target.provenance.spans;
        const content = spans.map(span => span.text).join('');
        let start = content.length, removed = 0;
        if (proposal.operation !== 'append') {
          if (typeof proposal.before !== 'string' || !proposal.before.length) { invalid.add(proposal.targetId); continue; }
          start = content.indexOf(proposal.before);
          if (start < 0 || content.indexOf(proposal.before, start + 1) >= 0) { invalid.add(proposal.targetId); continue; }
          removed = proposal.before.length;
        }
        const parent = this.proposal(proposal, index, depth + 1);
        const replacement: Span[] = proposal.after.length ? [{ text: proposal.after, rootIds: parent.rootIds,
          derivedFrom: unique([...parent.derivedFrom, proposal.proposalId]) }] : [];
        targets.set(proposal.targetId, [...sliceSpans(spans, 0, start), ...replacement, ...sliceSpans(spans, start + removed, content.length)]);
      }
      const images = [...targets.entries()].filter(([id]) => !invalid.has(id)).map(([, spans]) => ({ content: spans.map(span => span.text).join(''), spans }));
      this.imageCache.set(index, images);
      return images;
    } finally {
      this.imageVisiting.delete(index);
    }
  }

  annotate(snapshot: Snapshot, before = this.jobs.length, depth = 0): Snapshot {
    const annotated = structuredClone(snapshot);
    for (const source of annotated.sources) {
      const id = artifactId(this.scope, source), ownRoot = this.root(id);
      const matches: Match[] = [];
      for (let index = 0; index < before; index++) {
        const job = this.jobs[index];
        for (const proposal of Array.isArray(job.proposals) ? job.proposals : []) {
          if (!applied(job, proposal) || proposal.operation === 'retain'
            || typeof proposal.after !== 'string' || !proposal.after.trim()) continue;
          let start = source.content.indexOf(proposal.after);
          if (start < 0) continue;
          const parent = this.proposal(proposal, index, depth);
          const derivedFrom = unique([...parent.derivedFrom, proposal.proposalId]);
          while (start >= 0) {
            matches.push({ start, end: start + proposal.after.length, text: proposal.after, rootIds: parent.rootIds, derivedFrom });
            start = source.content.indexOf(proposal.after, start + 1);
          }
        }
        for (const image of this.afterImages(index, depth)) {
          if (!image.content.trim()) continue;
          let start = source.content.indexOf(image.content);
          while (start >= 0) {
            let offset = start;
            for (const span of image.spans) {
              // Require the complete after-image, not an arbitrary short remnant
              // such as punctuation. Only derived spans transfer across paths.
              if (span.derivedFrom.length) matches.push({ ...span, start: offset, end: offset + span.text.length });
              offset += span.text.length;
            }
            start = source.content.indexOf(image.content, start + 1);
          }
        }
      }
      const spans = partition(source.content, matches, ownRoot);
      const derivedFrom = unique(spans.flatMap(span => span.derivedFrom));
      const hasOwnText = spans.some(span => span.derivedFrom.length === 0 && span.text.trim().length > 0);
      source.provenance = { schemaVersion: 1, kind: derivedFrom.length ? (hasOwnText ? 'mixed' : 'derived') : 'file-artifact',
        artifactId: id, contentHash: hash(source.content), rootIds: source.content.length ? unique(spans.flatMap(span => span.rootIds)) : [ownRoot],
        derivedFrom, independentEvents: 'unknown', spans };
    }
    return annotated;
  }
}

function uniqueApplied(job: Job): string[] {
  return Array.isArray(job.appliedProposalIds) ? [...new Set(job.appliedProposalIds)] : [];
}

function sliceSpans(spans: Span[], start: number, end: number): Span[] {
  const result: Span[] = [];
  let offset = 0;
  for (const span of spans) {
    const next = offset + span.text.length;
    if (offset < end && next > start) result.push({ ...span, text: span.text.slice(Math.max(start - offset, 0), Math.min(end - offset, span.text.length)) });
    offset = next;
  }
  return result;
}

/** Ordered exhaustive spans preserve offsets without storing filesystem details. */
function partition(content: string, matches: Match[], ownRoot: string): Span[] {
  if (!content.length) return [];
  if (!matches.length) return [{ text: content, rootIds: [ownRoot], derivedFrom: [] }];
  const boundaries = [...new Set([0, content.length, ...matches.flatMap(match => [match.start, match.end])])].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i];
    const covering = matches.filter(match => match.start <= start && match.end >= end);
    const text = content.slice(start, end);
    const rootIds = covering.length ? unique(covering.flatMap(match => match.rootIds)) : text.trim() ? [ownRoot] : [];
    const derivedFrom = unique(covering.flatMap(match => match.derivedFrom));
    const previous = spans.at(-1);
    if (previous && isDeepStrictEqual(previous.rootIds, rootIds) && isDeepStrictEqual(previous.derivedFrom, derivedFrom)) previous.text += text;
    else spans.push({ text, rootIds, derivedFrom });
  }
  return spans;
}

/** Rebuild provenance from raw snapshot bytes and same-scope durable jobs only. */
export function annotateSnapshot(snapshot: Snapshot, history: Job[]): Snapshot {
  return new Resolver(snapshot.scope, history, snapshot).annotate(snapshot);
}

function evidenceLineage(proposal: Proposal, snapshot: Snapshot): EvidenceLineage {
  const rootIds: string[] = [], derivedFrom: string[] = [];
  for (const evidence of Array.isArray(proposal.evidence) ? proposal.evidence : []) {
    if (typeof evidence.quote !== 'string' || !evidence.quote.trim()) continue;
    const source = snapshot.sources.find(item => item.sourceId === evidence.sourceId);
    if (!source || !hasBoundProvenance(source, snapshot.scope)) continue;
    const spans = source.provenance.spans ?? [{ text: source.content, rootIds: source.provenance.rootIds, derivedFrom: [] }];
    let start = source.content.indexOf(evidence.quote);
    // Ambiguous repeated quotes conservatively union matching origins; never pick
    // an unrelated derived span elsewhere in the file just because it exists.
    while (start >= 0) {
      const end = start + evidence.quote.length;
      let offset = 0;
      for (const span of spans) {
        const next = offset + span.text.length;
        if (offset < end && next > start && source.content.slice(Math.max(offset, start), Math.min(next, end)).trim()) {
          rootIds.push(...span.rootIds); derivedFrom.push(...span.derivedFrom);
        }
        offset = next;
      }
      start = source.content.indexOf(evidence.quote, start + 1);
    }
  }
  return { policyVersion: 1, rootIds: unique(rootIds), derivedFrom: unique(derivedFrom), independentEvents: 'unknown' };
}

/** Proposal.lineage is never consulted; worker input may use Host-bound spans. */
export function proposalLineage(proposal: Proposal, snapshot: Snapshot, history?: Job[]): EvidenceLineage {
  if (history !== undefined) return evidenceLineage(proposal, annotateSnapshot(snapshot, history));
  const fallback = annotateSnapshot(snapshot, []);
  const annotated = { ...fallback, sources: snapshot.sources.map((source, index) => hasBoundProvenance(source, snapshot.scope) ? source : fallback.sources[index]) };
  return evidenceLineage(proposal, annotated);
}

function validConsolidation(value: unknown): value is Consolidation {
  if (!record(value) || typeof value.claimKey !== 'string' || !value.claimKey.trim()
    || !['add', 'keep', 'reinforce', 'merge', 'correct', 'promote', 'needs-verification'].includes(value.action as string)
    || !['explicit', 'observation', 'correction', 'recurrence', 'uncertain'].includes(value.basis as string)) return false;
  const a = value.applicability;
  return record(a) && typeof a.topic === 'string' && typeof a.conditions === 'string'
    && (a.validFrom === undefined || typeof a.validFrom === 'string') && (a.validUntil === undefined || typeof a.validUntil === 'string');
}

type Group = { item: Candidate };

function verdict(job: Job, proposal: Proposal): Candidate['status'] {
  // Reviews are an append-only ledger. A later deferral or invalidation must not
  // fall through to an earlier acceptance of this proposal (or another revision).
  const review = (Array.isArray(job.reviews) ? job.reviews : []).findLast(item => item.proposalId === proposal.proposalId && item.jobId === job.jobId);
  if (review) {
    if (!isDeepStrictEqual(review.proposalSnapshot, proposal) || review.decision === 'defer'
      || (review.decision === 'accept' && job.invalidatedReviewIds?.includes(review.reviewId))) return 'pending';
    if (review.decision === 'reject') return 'rejected';
    if (review.decision !== 'accept') return 'pending';
    if (proposal.operation === 'retain') return 'retained';
  }
  // The applied ledger also survives legacy jobs that lack review metadata.
  return applied(job, proposal) && proposal.operation !== 'retain' ? 'active' : 'pending';
}

/** Bounded view over durable jobs, not a new mutable candidate registry or score. */
export function candidateView(history: Job[], scope: Scope, limit: number): CandidateView {
  const resolver = new Resolver(scope, history);
  const groups = new Map<string, Group>();
  resolver.jobs.forEach((job, index) => {
    for (const proposal of Array.isArray(job.proposals) ? job.proposals : []) {
      if (!validConsolidation(proposal.consolidation)) continue;
      const consolidation = proposal.consolidation;
      const id = candidateId(consolidation, scope);
      let group = groups.get(id);
      if (!group) {
        group = { item: { candidateId: id, claimKey: consolidation.claimKey, applicability: structuredClone(consolidation.applicability) as Applicability,
          proposalIds: [], rootIds: [], independentEvents: 'unknown', status: 'pending', text: '' } };
        groups.set(id, group);
      }
      const lineage = resolver.proposal(proposal, index);
      group.item.proposalIds = unique([...group.item.proposalIds, proposal.proposalId]);
      group.item.rootIds = unique([...group.item.rootIds, ...lineage.rootIds]);
      // Generator summaries/reasons are intentionally not candidate descriptions.
      group.item.text = typeof proposal.after === 'string' && proposal.after.trim() ? proposal.after.trim()
        : typeof proposal.before === 'string' ? proposal.before.trim() : '';
      // Text and verdict describe the same latest proposal revision. Historic
      // origins remain visible, but cannot lend an approval to unreviewed text.
      group.item.status = verdict(job, proposal);
    }
  });
  const items = [...groups.values()].map(group => group.item).sort((a, b) => compare(a.candidateId, b.candidateId));
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const selected: Candidate[] = [];
  let bytes = 2; // JSON array brackets; text, ids and applicability stay exact.
  for (const item of items) {
    if (selected.length >= maximum) break;
    const added = Buffer.byteLength(JSON.stringify(item), 'utf8') + (selected.length ? 1 : 0);
    if (bytes + added > 65_536) continue; // Omit a whole item, never truncate evidence/diffs.
    selected.push(item);
    bytes += added;
  }
  return { items: selected, total: items.length, truncated: selected.length < items.length };
}
