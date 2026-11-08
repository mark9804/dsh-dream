import type { Snapshot } from '../types.js';
import type { EpisodeDigest } from '../dream/episodes.js';

export interface DreamContextOptions {
  sessionId: string;
  sourceSessionIds: string[];
  dreamContextRefs: { sessionId: string; seq: number }[];
  maxDreamContextBytes: number;
}
export interface DreamConversation {
  messages: { sessionId: string; seq: number; role: 'user' | 'assistant'; text: string }[];
  /** requested/unavailable count refs; included counts messages; omitted counts
   * excluded unique events plus over-budget refs. These are not a coverage ratio. */
  coverage: { requested: number; included: number; omitted: number; unavailable: number; reasons: string[] };
}
interface SessionQuery {
  readEvent(request: { sessionId: string; seq: number; before: number; after: number }, signal?: AbortSignal): Promise<unknown>;
  traceEvent(request: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<unknown>;
}
interface QueryAccess { get?(name: 'sessionQuery'): unknown }
type Ref = DreamContextOptions['dreamContextRefs'][number];
type Message = DreamConversation['messages'][number];
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const seq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const refKey = (ref: Ref) => JSON.stringify([ref.sessionId, ref.seq]);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const validRef = (value: unknown): value is Ref => record(value) && text(value.sessionId) && seq(value.seq);

async function cancellable(run: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (!signal) return run();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const started = Promise.resolve().then(() => { signal.throwIfAborted(); return run(); });
  try {
    const value = await Promise.race([started, cancelled]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Preserve the caller's cancellation while draining an already-started read.
    // An uncooperative backend can delay settlement; no orphan read is hidden.
    await started.catch(() => {});
  }
}

/** Extract only public text, never reasoning/stream/replay/tool content. */
function publicMessage(event: RecordValue, sessionId: string, maxBytes: number): { message?: Message; reason?: string } {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return { reason: 'non_conversation_event' };
  if (event.surfaceOp !== 'append' || (event.sourceEventSeqs !== undefined && (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length))) return { reason: 'derived_or_replacement' };
  if (!record(event.data)) return { reason: 'malformed_message' };
  const role = event.type === 'user/message' ? 'user' : 'assistant';
  const message = role === 'user' ? event.data : event.data.message;
  if (!record(message) || message.role !== role || !text(message.id) || !record(message.source)
    || message.source.kind !== (role === 'user' ? 'user' : 'model') || !Array.isArray(message.content)) return { reason: 'non_direct_or_malformed_message' };
  if (event.data.interrupted !== undefined || event.data.error !== undefined || message.isError === true) return { reason: 'failed_or_interrupted_message' };
  if (role === 'assistant') {
    if (!text(message.source.provider) || !text(message.source.model) || !Array.isArray(event.data.stream)) return { reason: 'malformed_message' };
    for (const part of event.data.stream) {
      if (!record(part) || !['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'chunk'].includes(String(part.type))) return { reason: 'malformed_message' };
      if (part.type === 'chunk') {
        if (!record(part.chunk) || !text(part.chunk.type)) return { reason: 'malformed_message' };
        if (part.chunk.type === 'finish') {
          if (!record(part.chunk.reason) || !['stop', 'tool-calls'].includes(String(part.chunk.reason.kind))) return { reason: 'failed_or_interrupted_message' };
        }
      }
    }
  }
  const parts: string[] = [];
  let size = 0;
  for (const block of message.content) {
    if (!record(block) || !text(block.type)) return { reason: 'malformed_message' };
    if (block.type !== 'text') continue;
    if (typeof block.text !== 'string') return { reason: 'malformed_message' };
    size += Buffer.byteLength(block.text, 'utf8') + (parts.length ? 1 : 0);
    if (size > maxBytes) return { reason: 'message_byte_limit' };
    parts.push(block.text);
  }
  const joined = parts.join('\n');
  if (!joined.length) return { reason: 'no_public_text' };
  return { message: { sessionId, seq: event.seq as number, role, text: joined } };
}

function validWindow(value: unknown, ref: Ref): value is RecordValue & { session: RecordValue; target: RecordValue; events: RecordValue[] } {
  if (!record(value) || !record(value.session) || value.session.id !== ref.sessionId || typeof value.session.isSeeded !== 'boolean'
    || !seq(value.inheritedEventCount) || !record(value.target) || value.target.seq !== ref.seq || !text(value.target.type)
    || typeof value.target.time !== 'number' || !Number.isFinite(value.target.time)
    || !Array.isArray(value.events) || !value.events.length || value.events.length > 5) return false;
  let previous = -1;
  let targetIndex = -1;
  for (let i = 0; i < value.events.length; i++) {
    const event: unknown = value.events[i];
    if (!record(event) || !seq(event.seq) || event.seq <= previous || !text(event.type) || typeof event.time !== 'number' || !Number.isFinite(event.time)) return false;
    previous = event.seq;
    if (event.seq === ref.seq) {
      if (event.type !== value.target.type || event.time !== value.target.time) return false;
      targetIndex = i;
    }
  }
  return targetIndex >= 0 && targetIndex <= 2 && value.events.length - targetIndex - 1 <= 2
    && value.startSeq === value.events[0].seq && value.endSeq === value.events[value.events.length - 1].seq;
}

function validTrace(value: unknown, ref: Ref, type: unknown, time: unknown): boolean {
  return record(value) && record(value.session) && value.session.id === ref.sessionId && value.session.isSeeded === false
    && record(value.target) && value.target.sessionId === ref.sessionId && value.target.seq === ref.seq
    && value.target.type === type && value.target.time === time
    && value.target.surface === 'current' && value.replacedBy === undefined
    && ['replacedEventSeqs', 'sourceEventSeqs', 'replacementChain', 'derivedEventSeqs'].every(key => Array.isArray(value[key]) && value[key].every(seq))
    && (value.replacedEventSeqs as unknown[]).length === 0 && (value.sourceEventSeqs as unknown[]).length === 0;
}

/**
 * Creative context only, not evidence. At most 16 authorized exact windows,
 * each two raw events before/after its target (sequence numbers are NOT ordinals).
 * Seeded sessions fail closed; no ancestor, session-list, search or file fallback.
 * The byte limit bounds the returned JSON, not Host internal log allocations.
 * Coverage units: requested/unavailable count refs; included counts messages;
 * omitted counts excluded unique events plus refs beyond the 16-window budget.
 */
export function createDreamContextReader(ctx: unknown, options: DreamContextOptions): (snapshot: Snapshot, digest: EpisodeDigest, options?: { signal?: AbortSignal }) => Promise<DreamConversation> {
  const maxBytes = options.maxDreamContextBytes ?? 16384;
  if (!text(options.sessionId) || !Array.isArray(options.sourceSessionIds) || !options.sourceSessionIds.every(text)
    || !Array.isArray(options.dreamContextRefs) || options.dreamContextRefs.length > 16 || !options.dreamContextRefs.every(validRef)) throw new TypeError('Invalid dream context authorization or references');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > 65536) throw new RangeError('Invalid maxDreamContextBytes (512..65536)');
  const allowlist = new Set([options.sessionId, ...options.sourceSessionIds]);
  const sessionId = options.sessionId;
  const explicit = options.dreamContextRefs.map(ref => ({ sessionId: ref.sessionId, seq: ref.seq }));
  return async (snapshot, digest, { signal } = {}) => {
    signal?.throwIfAborted();
    const result: DreamConversation = { messages: [], coverage: { requested: 0, included: 0, omitted: 0, unavailable: 0, reasons: [] } };
    const reason = (value: string) => {
      if (result.coverage.reasons.includes(value)) return;
      // Keep diagnostics bounded even with the smallest allowed total budget.
      if (result.coverage.reasons.length < 5) result.coverage.reasons.push(value);
      else if (!result.coverage.reasons.includes('additional_reasons_omitted')) result.coverage.reasons.push('additional_reasons_omitted');
    };
    const refs = new Map<string, Ref>(explicit.map(ref => [refKey(ref), ref]));
    // Snapshot and digest are locally prepared inputs. Read source identities and
    // receipts only; never source.content or arbitrary source paths through ctx.
    if (!record(snapshot) || !record(snapshot.scope) || snapshot.scope.sessionId !== sessionId
      || !record(digest) || digest.snapshotId !== snapshot.snapshotId || !Array.isArray(digest.episodes) || !Array.isArray(snapshot.sources)) {
      result.coverage.requested = refs.size;
      result.coverage.unavailable = Math.max(1, refs.size);
      reason('input_scope_mismatch');
      return result;
    }
    for (const episode of digest.episodes) {
      if (!record(episode) || !Array.isArray(episode.evidence)) continue;
      for (const evidence of episode.evidence) {
        if (!record(evidence) || !text(evidence.sourceId) || !text(evidence.quote)) continue;
        for (const source of snapshot.sources) {
          if (source.sourceId !== evidence.sourceId || !Array.isArray(source.originals)) continue;
          for (const receipt of source.originals) {
            if (receipt.status !== 'verified' || !validRef(receipt.canonical) || !record(receipt.ref) || !text(receipt.ref.quote)
              || !(receipt.ref.quote.includes(evidence.quote) || evidence.quote.includes(receipt.ref.quote))) continue;
            const ref = { sessionId: receipt.canonical.sessionId, seq: receipt.canonical.seq };
            if (!refs.has(refKey(ref))) refs.set(refKey(ref), ref);
          }
        }
      }
    }
    result.coverage.requested = refs.size;
    if (!refs.size) { reason('no_context_references'); return result; }
    const selected = [...refs.values()].slice(0, 16);
    if (refs.size > selected.length) { result.coverage.omitted += refs.size - selected.length; reason('reference_limit'); }
    const seen = new Set<string>();
    for (const ref of selected) {
      signal?.throwIfAborted();
      if (!allowlist.has(ref.sessionId)) { result.coverage.unavailable++; reason('session_not_authorized'); continue; }
      try {
        const service = (ctx as QueryAccess | null)?.get?.('sessionQuery');
        if (!record(service) || typeof service.readEvent !== 'function' || typeof service.traceEvent !== 'function') { result.coverage.unavailable++; reason('session_query_unavailable'); continue; }
        const query = service as unknown as SessionQuery;
        const window = await cancellable(() => query.readEvent({ ...ref, before: 2, after: 2 }, signal), signal);
        if (!validWindow(window, ref)) { result.coverage.unavailable++; reason('invalid_event_window'); continue; }
        if (window.session.isSeeded || window.inheritedEventCount !== 0) { result.coverage.unavailable++; reason('inherited_ancestry_incomplete'); continue; }
        // Detach selected public strings before the next await. No raw event or
        // provider replay state enters the result or the narrative prompt.
        const candidates = window.events.map(event => {
          const raw = event.seq === ref.seq ? window.target : event;
          return { key: refKey({ sessionId: ref.sessionId, seq: event.seq as number }), ...publicMessage(raw, ref.sessionId, maxBytes) };
        });
        const type = window.target.type;
        const time = window.target.time;
        const trace = await cancellable(() => query.traceEvent(ref, signal), signal);
        if (!validTrace(trace, ref, type, time)) { result.coverage.unavailable++; reason('invalid_event_trace'); continue; }
        for (const candidate of candidates) {
          if (seen.has(candidate.key)) continue;
          seen.add(candidate.key);
          if (!candidate.message) { result.coverage.omitted++; reason(candidate.reason ?? 'malformed_message'); continue; }
          if (candidate.message.seq !== ref.seq) reason('neighbors_not_evidence');
          result.messages.push(candidate.message);
          result.coverage.included = result.messages.length;
          if (bytes(result) > maxBytes) { result.messages.pop(); result.coverage.included--; result.coverage.omitted++; reason('message_byte_limit'); }
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        result.coverage.unavailable++;
        reason('session_query_failed');
      }
    }
    // Later coverage growth may consume the few bytes left by an earlier item.
    while (bytes(result) > maxBytes && result.messages.length) {
      result.messages.pop(); result.coverage.included--; result.coverage.omitted++; reason('message_byte_limit');
    }
    signal?.throwIfAborted();
    return result;
  };
}
