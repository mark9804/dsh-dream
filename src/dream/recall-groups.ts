import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateSnapshot } from '../domain/contracts.js';
import type { RecallHit } from './recall.js';
import type { Snapshot, Source } from '../types.js';

const MAX_MEMBERS = 16;
const MAX_MEMBER_BYTES = 2048;
const MAX_GROUP_BYTES = 16384;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');

export interface RecallGroupMember {
  sourceId: string;
  path: string;
  sourceRole: Source['role'];
  sensitivity?: Source['sensitivity'];
  version: RecallHit['version'];
  proof: RecallHit['proof'];
}

export interface RecallHitGroup {
  groupId: string;
  kind: 'display-only-not-event-identity';
  independentEvents: 'unknown';
  memberCount: number;
  members: RecallGroupMember[];
  omittedMembers: number;
}

export interface RecallGroupingCoverage {
  inputHits: number;
  groups: number;
  collapsedHits: number;
  memberLocations: number;
  omittedMemberLocations: number;
  policy: string;
  nearDuplicatesOnlyDisplay: string;
}

type DisplayHit = RecallHit & { group?: RecallHitGroup };
type Group = { normalizedText: string; hits: DisplayHit[] };

/** A proof must bind both the complete fragment and its displayed window to the
 * same current source. An unbound hit stays independent; it cannot collapse one. */
function completeFragment(hit: DisplayHit, source: Source | undefined, contentHash: string | undefined): string | undefined {
  const proof = hit.proof;
  if (hit.group || !source || source.path !== hit.path || source.role !== hit.sourceRole
    || !isDeepStrictEqual(source.version, hit.version) || !proof || proof.kind !== 'current-source'
    || proof.offsetUnit !== 'utf16-code-units' || proof.contentHash !== contentHash) return;
  const { start, end, fragmentStart, fragmentEnd } = proof;
  if (![start, end, fragmentStart, fragmentEnd].every(Number.isSafeInteger)
    || fragmentStart < 0 || fragmentStart > start || start >= end || end > fragmentEnd || fragmentEnd > source.content.length) return;
  // UTF-16 offsets must not cut through a surrogate pair.
  for (const offset of [start, end, fragmentStart, fragmentEnd]) {
    if (offset > 0 && offset < source.content.length && /[\uD800-\uDBFF]/u.test(source.content[offset - 1]) && /[\uDC00-\uDFFF]/u.test(source.content[offset])) return;
  }
  const text = source.content.slice(start, end);
  const fragment = source.content.slice(fragmentStart, fragmentEnd);
  if (text !== hit.text || proof.textBytes !== Buffer.byteLength(text, 'utf8')
    || proof.fragmentBytes !== Buffer.byteLength(fragment, 'utf8')
    || proof.truncated !== (start !== fragmentStart || end !== fragmentEnd)) return;
  return fragment;
}

function rank(a: DisplayHit, b: DisplayHit): number {
  return b.score - a.score || b.baseScore - a.baseScore || compare(a.sourceId, b.sourceId)
    || compare(a.path, b.path) || a.proof.fragmentStart - b.proof.fragmentStart
    || a.proof.fragmentEnd - b.proof.fragmentEnd || a.proof.start - b.proof.start || a.proof.end - b.proof.end
    || compare(a.candidateId ?? '', b.candidateId ?? '') || compare(JSON.stringify(a), JSON.stringify(b));
}

function location(hit: DisplayHit): string {
  // Every grouped proof already has the snapshot's exact version/hash. Windows
  // over one full fragment are one location, not repeated evidence or events.
  return JSON.stringify([hit.sourceId, hit.path, hit.proof.contentHash, hit.proof.fragmentStart, hit.proof.fragmentEnd]);
}

function member(hit: DisplayHit): RecallGroupMember {
  return structuredClone({ sourceId: hit.sourceId, path: hit.path, sourceRole: hit.sourceRole, ...(hit.sensitivity ? { sensitivity: hit.sensitivity } : {}), version: hit.version, proof: hit.proof });
}

/** Pure display grouping before top-K. Equality is NFKC + whitespace collapse on
 * complete raw fragments, never on clipped snippets. No case folding, punctuation
 * removal, copy-label heuristics, number removal, fuzzy or semantic matching.
 * Identical text on different dates may share a display group, but every dated
 * location remains separate and the group is NOT a claim of event identity. */
export function groupRecallHits(hits: ReadonlyArray<RecallHit>, snapshot: Snapshot): { hits: RecallHit[]; coverage: RecallGroupingCoverage } {
  validateSnapshot(snapshot);
  if (!Array.isArray(hits)) throw new TypeError('Recall grouping requires a hit array');
  const sources = new Map(snapshot.sources.map(source => [source.sourceId, source]));
  const hashes = new Map(snapshot.sources.map(source => [source.sourceId, hash(source.content)]));
  const groups = new Map<string, Group>();
  const independent: DisplayHit[] = [];
  for (const input of hits) {
    const hit: DisplayHit = input;
    const fragment = completeFragment(hit, sources.get(hit.sourceId), hashes.get(hit.sourceId));
    const key = fragment === undefined ? '' : normalized(fragment);
    if (!key) { independent.push(structuredClone(hit)); continue; }
    const group = groups.get(key);
    if (group) group.hits.push(hit);
    else groups.set(key, { normalizedText: key, hits: [hit] });
  }
  const scope = snapshot.scope;
  const scopeKey = JSON.stringify([scope.scopeId, scope.agentId, scope.sessionId, scope.memoryRootId]);
  let memberLocations = independent.length, omittedMemberLocations = 0;
  const result: DisplayHit[] = [...independent];
  for (const group of groups.values()) {
    const ordered = [...group.hits].sort(rank);
    const representative = structuredClone(ordered[0]);
    const locations = new Map<string, DisplayHit>();
    for (const hit of ordered) if (!locations.has(location(hit))) locations.set(location(hit), hit);
    memberLocations += locations.size;
    if (ordered.length > 1) {
      const display: RecallHitGroup = { groupId: `recall-group-${hash(JSON.stringify([scopeKey, group.normalizedText]))}`,
        kind: 'display-only-not-event-identity', independentEvents: 'unknown', memberCount: locations.size, members: [], omittedMembers: locations.size };
      for (const hit of locations.values()) {
        if (display.members.length >= MAX_MEMBERS) break;
        const next = member(hit);
        if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_MEMBER_BYTES) continue;
        display.members.push(next);
        display.omittedMembers = locations.size - display.members.length;
        if (Buffer.byteLength(JSON.stringify(display), 'utf8') > MAX_GROUP_BYTES) {
          display.members.pop(); display.omittedMembers = locations.size - display.members.length;
        }
      }
      omittedMemberLocations += display.omittedMembers;
      representative.group = display;
    }
    result.push(representative);
  }
  result.sort(rank);
  return { hits: result, coverage: { inputHits: hits.length, groups: result.length, collapsedHits: hits.length - result.length,
    memberLocations, omittedMemberLocations,
    policy: 'Before top-K: complete current proof-bound fragment equality after NFKC and whitespace normalization only. Preserve the highest original ranked representative unchanged; never sum scores, reinforcement, receipts or credibility. groups counts output display rows; memberLocations counts unique exact full-fragment locations plus independent rows, not events. Members include the representative and retain exact source/path/version/proof; at most 16 per group, 2048 UTF-8 serialized bytes each and 16384 bytes per group, omitting whole oversized members. Unbound or already-grouped hits stay independent. No source content is changed.',
    nearDuplicatesOnlyDisplay: 'Only Unicode/whitespace-equivalent bodies share display; no fuzzy, semantic, ordinal, copy-label, number, negation or subject reduction. Different dated locations remain distinct evidence locations. All groups are display-only-not-event-identity; independent events remain unknown.' } };
}
