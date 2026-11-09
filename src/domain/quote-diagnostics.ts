import type { Source } from '../types.js';

import type { QuoteValidationIssue } from './validation-debug.js';
export type { QuoteValidationIssue } from './validation-debug.js';

const TEXT_LIMIT = 2048;
const ID_LIMIT = 2048;
const PATH_LIMIT = 4096;
const SOURCE_LIMIT = 262_144;
const CANDIDATE_LIMIT = 4096;
const ALGORITHM = 'character-bigram-dice-v1' as const;

type Range = { start: number; end: number };
type Input = { episodeIndex: number; evidenceIndex: number; episodeId: string; sourceId: string; source?: Source; quote: string };

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid quote validation issue: ${message}`);
}

function object(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  requireThat(Object.keys(value).every(key => keys.includes(key)), `unexpected ${name} fields`);
}

function integer(value: unknown, min: number, max: number, name: string): asserts value is number {
  requireThat(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, `${name} is out of bounds`);
}

function text(value: unknown, maximum: number, name: string): asserts value is string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= maximum, `${name} is out of bounds`);
}

/** UTF-16 limits and offsets are intentional; avoid displaying a split surrogate. */
function prefix(value: string, maximum: number): string {
  const end = Math.min(value.length, maximum);
  const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF ? end - 1 : end);
}

/** Strict, bounded IPC/storage shape; this validates diagnostics, not source truth. */
export function validateQuoteValidationIssue(value: unknown): QuoteValidationIssue {
  object(value, ['kind', 'episodeIndex', 'evidenceIndex', 'episodeId', 'sourceId', 'sourcePath', 'quote', 'quoteTruncated', 'nearest', 'algorithm', 'search', 'debugOnly', 'exactMatch'], 'issue');
  requireThat(value.kind === 'quote-not-found' && value.algorithm === ALGORITHM && value.debugOnly === true && value.exactMatch === false, 'diagnostic-only constants differ');
  integer(value.episodeIndex, 0, 127, 'episodeIndex');
  integer(value.evidenceIndex, 0, Number.MAX_SAFE_INTEGER, 'evidenceIndex');
  text(value.episodeId, ID_LIMIT, 'episodeId');
  text(value.sourceId, ID_LIMIT, 'sourceId');
  if (value.sourcePath !== undefined) text(value.sourcePath, PATH_LIMIT, 'sourcePath');
  text(value.quote, TEXT_LIMIT, 'quote');
  requireThat(typeof value.quoteTruncated === 'boolean', 'quoteTruncated must be boolean');
  object(value.search, ['sourceCharacters', 'searchedCharacters', 'candidates', 'truncated'], 'search');
  integer(value.search.sourceCharacters, 0, Number.MAX_SAFE_INTEGER, 'sourceCharacters');
  integer(value.search.searchedCharacters, 0, Math.min(SOURCE_LIMIT, value.search.sourceCharacters), 'searchedCharacters');
  integer(value.search.candidates, 0, CANDIDATE_LIMIT, 'candidates');
  requireThat(typeof value.search.truncated === 'boolean', 'search.truncated must be boolean');
  requireThat((!value.quoteTruncated && value.search.sourceCharacters === value.search.searchedCharacters) || value.search.truncated === true, 'incomplete search must be marked truncated');
  if (value.nearest === null) {
    requireThat(value.search.candidates === 0, 'nearest is required for scored candidates');
  } else {
    object(value.nearest, ['text', 'start', 'end', 'lineStart', 'lineEnd', 'similarity'], 'nearest');
    text(value.nearest.text, TEXT_LIMIT, 'nearest.text');
    integer(value.nearest.start, 0, value.search.searchedCharacters, 'nearest.start');
    integer(value.nearest.end, value.nearest.start + 1, value.search.searchedCharacters, 'nearest.end');
    requireThat(value.nearest.end - value.nearest.start === value.nearest.text.length, 'nearest offsets must match its UTF-16 length');
    integer(value.nearest.lineStart, 1, value.nearest.start + 1, 'nearest.lineStart');
    integer(value.nearest.lineEnd, value.nearest.lineStart, value.nearest.lineStart + value.nearest.text.length, 'nearest.lineEnd');
    let newlines = 0;
    for (let i = 0; i < value.nearest.text.length - 1; i++) if (value.nearest.text[i] === '\n') newlines++;
    requireThat(value.nearest.lineEnd === value.nearest.lineStart + newlines, 'nearest line range differs from its text');
    requireThat(typeof value.nearest.similarity === 'number' && Number.isFinite(value.nearest.similarity) && value.nearest.similarity >= 0 && value.nearest.similarity <= 1, 'similarity must be between zero and one');
    requireThat(value.search.candidates > 0, 'nearest requires scored candidates');
  }
  return value as unknown as QuoteValidationIssue;
}

function gramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 1; i < value.length; i++) {
    const gram = value.slice(i - 1, i + 1);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Raw UTF-16 character-bigram multiset Dice; no normalization or semantic probability. */
function dice(query: string, counts: Map<string, number>, candidate: string): number {
  if (query.length === 1 || candidate.length === 1) return query === candidate ? 1 : 0;
  const seen = new Map<string, number>();
  let common = 0;
  for (let i = 1; i < candidate.length; i++) {
    const gram = candidate.slice(i - 1, i + 1), available = counts.get(gram) ?? 0;
    if (!available) continue;
    const used = seen.get(gram) ?? 0;
    if (used < available) { common++; seen.set(gram, used + 1); }
  }
  return 2 * common / (query.length + candidate.length - 2);
}

/** Called only after the full, untruncated exact quote check has failed.
 * Search is deliberately diagnostic and sampled, never a repair or acceptance path.
 * Work <= bounded source scans + 4096 candidate scores of <=2048 code units each.
 */
export function createQuoteValidationIssue(input: Input): QuoteValidationIssue {
  integer(input.episodeIndex, 0, 127, 'episodeIndex');
  integer(input.evidenceIndex, 0, Number.MAX_SAFE_INTEGER, 'evidenceIndex');
  text(input.episodeId, ID_LIMIT, 'episodeId');
  text(input.sourceId, ID_LIMIT, 'sourceId');
  requireThat(typeof input.quote === 'string' && input.quote.length > 0, 'quote must be nonempty');
  // Refuse accidental foreign-source substitution even when the caller passes one.
  const source = input.source?.sourceId === input.sourceId ? input.source : undefined;
  if (source) text(source.path, PATH_LIMIT, 'sourcePath');
  const quote = prefix(input.quote, TEXT_LIMIT);
  const content = source ? prefix(source.content, SOURCE_LIMIT) : '';
  const quoteTruncated = quote.length !== input.quote.length;
  let truncated = quoteTruncated || (source?.content.length ?? 0) > content.length;
  const candidates = new Map<string, Range>();
  const lineBreaks: number[] = [];
  const segments: Range[] = [];
  let segmentStart = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineBreaks.push(i);
    if ('\n.!?。！？'.includes(content[i])) {
      segments.push({ start: segmentStart, end: i + 1 });
      segmentStart = i + 1;
    }
  }
  if (segmentStart < content.length) segments.push({ start: segmentStart, end: content.length });
  function add(start: number, end: number): void {
    start = Math.max(0, Math.min(start, content.length));
    end = Math.min(end, content.length, start + TEXT_LIMIT);
    while (start < end && /\s/.test(content[start])) start++;
    while (end > start && /\s/.test(content[end - 1])) end--;
    if (start === end) return;
    const first = content.charCodeAt(start), prior = content.charCodeAt(start - 1);
    if (first >= 0xDC00 && first <= 0xDFFF && prior >= 0xD800 && prior <= 0xDBFF) start++;
    const last = content.charCodeAt(end - 1), next = content.charCodeAt(end);
    if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
    if (start >= end) return;
    const key = `${start}:${end}`;
    if (candidates.has(key)) return;
    if (candidates.size >= CANDIDATE_LIMIT) { truncated = true; return; }
    candidates.set(key, { start, end });
  }
  function sample(length: number, budget: number, visit: (index: number) => void): void {
    const count = Math.min(length, budget);
    if (count < length) truncated = true;
    for (let i = 0; i < count; i++) visit(count === 1 ? 0 : Math.floor(i * (length - 1) / (count - 1)));
  }
  const widths = [...new Set([quote.length, Math.max(1, Math.floor(quote.length * 0.75)), Math.min(TEXT_LIMIT, Math.ceil(quote.length * 1.25))])];
  sample(segments.length, 1024, index => add(segments[index].start, segments[index].end));
  // Matching query bigrams propose aligned windows even in long lines; no raw
  // source outside the bounded prefix, and only three bounded linear scans.
  if (quote.length >= 2) {
    const anchors = [...new Set([0, Math.floor((quote.length - 2) / 2), quote.length - 2])];
    for (const anchor of anchors) {
      const gram = quote.slice(anchor, anchor + 2), positions: number[] = [];
      for (let i = 0; i + 1 < content.length; i++) if (content[i] === gram[0] && content[i + 1] === gram[1]) positions.push(i);
      sample(positions.length, 128, index => {
        const start = Math.max(0, positions[index] - anchor);
        for (const width of widths) add(start, start + width);
      });
    }
  }
  const uniformBudget = Math.floor((CANDIDATE_LIMIT - candidates.size) / widths.length);
  sample(content.length, uniformBudget, start => { for (const width of widths) add(start, start + width); });
  const counts = gramCounts(quote);
  let nearest: QuoteValidationIssue['nearest'] = null;
  let bestDistance = Infinity;
  for (const range of candidates.values()) {
    const excerpt = content.slice(range.start, range.end), similarity = dice(quote, counts, excerpt);
    const distance = Math.abs(quote.length - excerpt.length);
    if (!nearest || similarity > nearest.similarity || (similarity === nearest.similarity && (distance < bestDistance || (distance === bestDistance && range.start < nearest.start)))) {
      nearest = { text: excerpt, ...range, lineStart: 1, lineEnd: 1, similarity };
      bestDistance = distance;
    }
  }
  if (nearest) {
    for (const index of lineBreaks) {
      if (index < nearest.start) nearest.lineStart++;
      if (index < nearest.end - 1) nearest.lineEnd++;
    }
  }
  return validateQuoteValidationIssue({
    kind: 'quote-not-found', episodeIndex: input.episodeIndex, evidenceIndex: input.evidenceIndex,
    episodeId: input.episodeId, sourceId: input.sourceId, ...(source ? { sourcePath: source.path } : {}),
    quote, quoteTruncated, nearest, algorithm: ALGORITHM,
    search: { sourceCharacters: source?.content.length ?? 0, searchedCharacters: content.length, candidates: candidates.size, truncated },
    debugOnly: true, exactMatch: false,
  });
}

/** JSON escaping keeps hostile quotes/newlines as data; every display is bounded. */
export function formatQuoteValidationIssue(input: QuoteValidationIssue): string {
  const issue = validateQuoteValidationIssue(input);
  const display = (value: string) => JSON.stringify(prefix(value, 256)) + (value.length > 256 ? ' [display truncated]' : '');
  const nearest = issue.nearest
    ? `${JSON.stringify(issue.nearest.text)} utf16=[${issue.nearest.start},${issue.nearest.end}) lines=${issue.nearest.lineStart}-${issue.nearest.lineEnd} similarity=${issue.nearest.similarity.toFixed(6)}`
    : 'null';
  return `episode[${issue.episodeIndex}] evidence[${issue.evidenceIndex}] episodeId=${display(issue.episodeId)} sourceId=${display(issue.sourceId)}${issue.sourcePath ? ` sourcePath=${display(issue.sourcePath)}` : ''} quote=${JSON.stringify(issue.quote)} quoteTruncated=${issue.quoteTruncated} nearest=${nearest} algorithm=${issue.algorithm} search=${JSON.stringify(issue.search)} debugOnly=true exactMatch=false; approximate debug hint only, not an accepted quote or a probability`;
}

export class QuoteValidationError extends TypeError {
  readonly code = 'GENERATION_VALIDATION_FAILED';
  readonly validationIssue: QuoteValidationIssue;

  constructor(issue: QuoteValidationIssue) {
    const validated = validateQuoteValidationIssue(issue);
    super(`episode evidence quote is missing from its source; ${formatQuoteValidationIssue(validated)}`);
    this.name = 'QuoteValidationError';
    this.validationIssue = structuredClone(validated);
  }
}
