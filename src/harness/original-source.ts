import { createHash } from 'node:crypto';
import type { OriginalRef, OriginalReceipt, OriginalSourceVerifier } from '../types.js';
import type { HostContext } from './types.js';

// Exact optional service seam inspected through Host Service.listService on
// 2026-10-30; read/trace and native call links rechecked on 2026-11-06 (rc.1).
// Do not expand this into session search or full-log authority.
interface SessionQuery {
  readEvent(request: { sessionId: string; seq: number; before: number; after: number }, signal?: AbortSignal): Promise<unknown>;
  traceEvent(request: { sessionId: string; seq: number }, signal?: AbortSignal): Promise<unknown>;
}
interface SessionQueryAccess { get?(key: 'sessionQuery'): unknown }
interface OriginalSourceConfig { sessionId: string; sourceSessionIds: string[]; maxOriginalBytes: number }
type ObjectValue = Record<string, unknown>;

const record = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const seq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const header = (value: unknown): value is ObjectValue => record(value) && nonempty(value.id)
  && seq(value.version) && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
  && typeof value.isSeeded === 'boolean' && (value.parentSession === undefined || nonempty(value.parentSession));
class ByteLimit extends Error {}

/** Stable, complete lossless JSON, not a selected-field or quoted-text hash. */
function stableJson(value: unknown, maxBytes: number): string {
  const chunks: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) throw new ByteLimit();
    chunks.push(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 128) throw new TypeError('JSON depth exceeds verification limit');
    if (item === null) { emit('null'); return; }
    if (typeof item === 'string') {
      // Preflight the raw string before allocating its escaped representation.
      if (Buffer.byteLength(item, 'utf8') > maxBytes - bytes) throw new ByteLimit();
      emit(JSON.stringify(item)); return;
    }
    if (typeof item === 'boolean') { emit(String(item)); return; }
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) { emit(JSON.stringify(item)); return; }
    if (typeof item !== 'object' || ancestors.has(item)) throw new TypeError('Not lossless JSON');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError('Not a JSON object');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Not lossless JSON');
    ancestors.add(item);
    if (array) {
      if (Object.keys(item).length !== item.length) throw new TypeError('Not a dense JSON array');
      emit('[');
      for (let i = 0; i < item.length; i++) {
        if (i) emit(',');
        const property = Object.getOwnPropertyDescriptor(item, String(i));
        if (!property || !('value' in property) || !property.enumerable) throw new TypeError('Not a JSON array value');
        visit(property.value, depth + 1);
      }
      emit(']');
    } else {
      emit('{');
      let first = true;
      for (const key of Object.getOwnPropertyNames(item).sort()) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !('value' in property) || !property.enumerable) throw new TypeError('Not a JSON object value');
        if (!first) emit(',');
        first = false;
        visit(key, depth + 1); emit(':'); visit(property.value, depth + 1);
      }
      emit('}');
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  return chunks.join('');
}

/** Cancellation settles locally even if an optional backend ignores its signal. */
async function queryWithSignal(query: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (!signal) return query();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return query(); }), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function receiptRef(value: unknown, maxBytes: number): OriginalRef {
  // Do not reflect arbitrary input properties or an oversized quote in failures.
  const input = record(value) ? value : {};
  const boundedString = (text: unknown): string => {
    if (typeof text !== 'string') return '';
    try { stableJson(text, maxBytes); return text; } catch { return ''; }
  };
  return { sessionId: boundedString(input.sessionId), seq: seq(input.seq) ? input.seq : 0,
    blockIndex: seq(input.blockIndex) ? input.blockIndex : 0, quote: boundedString(input.quote) };
}

function messageOf(event: ObjectValue): { message?: ObjectValue; role?: 'user' | 'assistant' | 'tool'; reason?: string } {
  if (!record(event.data)) return { reason: 'malformed_event_data' };
  if (event.type === 'user/message') return { message: event.data, role: 'user' };
  if (event.type === 'assistant/message') return { message: record(event.data.message) ? event.data.message : undefined, role: 'assistant' };
  if (event.type === 'tool/result') return { message: record(event.data.message) ? event.data.message : undefined, role: 'tool' };
  return {};
}

type VerificationFailure = { status: 'invalid' | 'unavailable'; reason: string };

/** A narrow native pipeline association, not recursive derivation acceptance.
 * dsh-tools/lib/pipeline.js BatchSettlement.start/commit records the same
 * turn/step/callId, with one sourceEventSeq pointing to a tool/call. The result
 * carries no tool name; validate the call's recorded name, never invent one or
 * consult today's registry. Only this authorized same-session exact read occurs.
 */
async function verifyToolCall(query: SessionQuery, sessionId: string, callSeq: number, result: ObjectValue,
  message: ObjectValue, identity: ObjectValue, maxBytes: number, signal?: AbortSignal): Promise<VerificationFailure | undefined> {
  const fail = (status: VerificationFailure['status'], reason: string): VerificationFailure => ({ status, reason });
  const window = await queryWithSignal(() => query.readEvent({ sessionId, seq: callSeq, before: 0, after: 0 }, signal), signal);
  if (!record(window) || !header(window.session) || !seq(window.inheritedEventCount) || !record(window.target)) return fail('unavailable', 'malformed_tool_call_window');
  if (window.session.id !== sessionId) return fail('invalid', 'tool_call_session_mismatch');
  if (window.session.isSeeded || window.inheritedEventCount > 0) return fail('unavailable', 'inherited_ancestry_incomplete');
  if (window.session.version !== identity.version || window.session.createdAt !== identity.createdAt
    || window.session.parentSession !== identity.parentSession) return fail('invalid', 'tool_call_session_mismatch');
  let call: ObjectValue;
  try { call = JSON.parse(stableJson(window.target, maxBytes)); }
  catch (error) { return fail('unavailable', error instanceof ByteLimit ? 'tool_call_byte_limit' : 'malformed_tool_call_json'); }
  if (!seq(call.seq) || !nonempty(call.type) || typeof call.time !== 'number' || !Number.isFinite(call.time)) return fail('unavailable', 'malformed_tool_call_identity');
  if (call.seq !== callSeq || call.type !== 'tool/call') return fail('invalid', 'tool_call_event_mismatch');
  if (call.seq >= (result.seq as number) || call.time > (result.time as number)) return fail('invalid', 'tool_call_order_mismatch');
  // Log-only calls cannot themselves be surface replacements or cite sources.
  if (call.surfaceOp !== undefined || call.sourceEventSeqs !== undefined) return fail('invalid', 'derived_tool_call');
  if (!record(call.data) || !record(result.data) || !nonempty(call.data.callId) || !nonempty(call.data.name)
    || !call.data.name.trim() || typeof call.data.arguments !== 'string' || !seq(call.data.turn) || !seq(call.data.step)
    || !seq(result.data.turn) || !seq(result.data.step)) return fail('unavailable', 'malformed_tool_call_data');
  if (call.data.callId !== message.toolCallId || call.data.turn !== result.data.turn || call.data.step !== result.data.step) return fail('invalid', 'tool_call_identity_mismatch');
  if (call.data.interrupted !== undefined || call.data.error !== undefined || call.data.isError !== undefined) return fail('invalid', 'failed_or_interrupted_tool_call');
  const traceValue = await queryWithSignal(() => query.traceEvent({ sessionId, seq: callSeq }, signal), signal);
  let trace: unknown;
  try { trace = JSON.parse(stableJson(traceValue, maxBytes)); }
  catch (error) { return fail('unavailable', error instanceof ByteLimit ? 'tool_call_trace_byte_limit' : 'malformed_tool_call_trace'); }
  if (!record(trace) || !header(trace.session) || !record(trace.target) || !nonempty(trace.target.sessionId)
    || !seq(trace.target.seq) || !nonempty(trace.target.type) || typeof trace.target.time !== 'number'
    || !['replacementChain', 'replacedEventSeqs', 'sourceEventSeqs', 'derivedEventSeqs'].every(key => Array.isArray(trace[key]) && trace[key].every(seq))) return fail('unavailable', 'malformed_tool_call_trace');
  if (trace.session.isSeeded) return fail('unavailable', 'inherited_ancestry_incomplete');
  if (trace.session.id !== sessionId || trace.target.sessionId !== sessionId || trace.target.seq !== callSeq
    || trace.target.type !== call.type || trace.target.time !== call.time || trace.session.version !== identity.version
    || trace.session.createdAt !== identity.createdAt || trace.session.parentSession !== identity.parentSession) return fail('invalid', 'tool_call_trace_identity_mismatch');
  if (trace.target.surface !== 'log-only' || trace.replacedBy !== undefined || (trace.replacementChain as number[]).length
    || (trace.replacedEventSeqs as number[]).length || (trace.sourceEventSeqs as number[]).length) return fail('invalid', 'derived_tool_call');
  // Reverse membership confirms the trace observed this exact result link.
  // Other later consumers may cite the call too; they are not extra results or
  // independent evidence, so do not infer uniqueness by their count.
  if (!(trace.derivedEventSeqs as number[]).includes(result.seq as number)) return fail('invalid', 'tool_call_trace_link_mismatch');
  return undefined;
}

/**
 * Proves only an exact recorded occurrence, never its semantic truth or an
 * independent supporting event. Only caller-authorized exact session/seq reads.
 * maxOriginalBytes bounds our retained serialization and receipt inputs; it does
 * NOT bound the Host backend's internal observation/full-log read allocations.
 */
export function createOriginalSourceVerifier(ctx: HostContext, config: OriginalSourceConfig): OriginalSourceVerifier {
  if (!nonempty(config.sessionId) || !Array.isArray(config.sourceSessionIds) || !config.sourceSessionIds.every(nonempty)) throw new TypeError('Invalid original source session authorization');
  if (!Number.isSafeInteger(config.maxOriginalBytes) || config.maxOriginalBytes <= 0) throw new RangeError('Invalid maxOriginalBytes');
  const authorized = new Set([config.sessionId, ...config.sourceSessionIds]);
  const maxBytes = config.maxOriginalBytes;
  return async (input, { signal } = {}) => {
    signal?.throwIfAborted();
    const ref = receiptRef(input, maxBytes);
    const finish = (status: OriginalReceipt['status'], reason: string): OriginalReceipt => ({ schemaVersion: 1, ref, status, reason, independentEvents: 'unknown' });
    if (!record(input) || !nonempty(input.sessionId) || !seq(input.seq) || !seq(input.blockIndex) || !nonempty(input.quote)) return finish('invalid', 'invalid_reference');
    if (ref.sessionId !== input.sessionId || ref.quote !== input.quote) return finish('invalid', 'reference_byte_limit');
    // Authorization precedes even optional service lookup. Copy the ref and
    // allowlist before awaiting, so callers cannot widen or retarget this read.
    if (!authorized.has(ref.sessionId)) return finish('invalid', 'session_not_authorized');
    try {
      const service = (ctx as unknown as SessionQueryAccess).get?.('sessionQuery');
      if (!record(service) || typeof service.readEvent !== 'function' || typeof service.traceEvent !== 'function') return finish('unavailable', 'session_query_unavailable');
      const query = service as unknown as SessionQuery;
      const window = await queryWithSignal(() => query.readEvent({ sessionId: ref.sessionId, seq: ref.seq, before: 0, after: 0 }, signal), signal);
      if (!record(window) || !header(window.session) || !seq(window.inheritedEventCount) || !record(window.target)) return finish('unavailable', 'malformed_event_window');
      if (window.session.id !== ref.sessionId) return finish('invalid', 'session_header_mismatch');
      // dsh-session README, "Fork a session": inheritedEventCount is a
      // SessionLogOffset (copied prefix LENGTH), not a SessionSeq. The exact
      // read/trace APIs expose no target offset or canonical parent-event link.
      // Even a child-owned target in a seeded session is conservatively unknown
      // here; do not guess seq < count or query a possibly unauthorized parent.
      if (window.session.isSeeded || window.inheritedEventCount > 0) return finish('unavailable', 'inherited_ancestry_incomplete');
      const identity = { version: window.session.version, createdAt: window.session.createdAt, parentSession: window.session.parentSession };
      let serialized: string;
      try { serialized = stableJson(window.target, maxBytes); }
      catch (error) { return finish('unavailable', error instanceof ByteLimit ? 'event_byte_limit' : 'malformed_event_json'); }
      // Hash and validate the same detached snapshot, even if a backend retains
      // and mutates its returned object while traceEvent is pending.
      const event: ObjectValue = JSON.parse(serialized);
      if (!seq(event.seq) || !nonempty(event.type) || typeof event.time !== 'number' || !Number.isFinite(event.time)) return finish('unavailable', 'malformed_event_identity');
      if (event.seq !== ref.seq) return finish('invalid', 'event_sequence_mismatch');
      if (!['user/message', 'assistant/message', 'tool/result'].includes(event.type)) return finish('invalid', 'unsupported_event_type');
      if (record(event.surfaceOp) && event.surfaceOp.op === 'replace') return finish('invalid', 'replacement_event');
      if (event.surfaceOp !== 'append') return finish('unavailable', 'malformed_surface_operation');
      let toolCallSeq: number | undefined;
      if (event.sourceEventSeqs !== undefined) {
        if (!Array.isArray(event.sourceEventSeqs)) return finish('unavailable', 'malformed_source_event_links');
        if (event.sourceEventSeqs.length) {
          // Native BatchSettlement links one result to its exact log-only call.
          // This is not permission to accept arbitrary source/summary links.
          if (event.type !== 'tool/result' || event.sourceEventSeqs.length !== 1) return finish('invalid', 'derived_source_event');
          if (!seq(event.sourceEventSeqs[0])) return finish('unavailable', 'malformed_source_event_links');
          toolCallSeq = event.sourceEventSeqs[0];
          if (toolCallSeq >= ref.seq) return finish('invalid', 'tool_call_order_mismatch');
        }
      }
      const { message, role, reason } = messageOf(event);
      if (reason || !message || !role || !record(event.data) || !nonempty(message.id) || !nonempty(message.role)
        || !record(message.source) || !nonempty(message.source.kind) || !Array.isArray(message.content)) return finish('unavailable', reason ?? 'malformed_message');
      if (message.role !== role) return finish('invalid', 'message_role_mismatch');
      const sourceKind = role === 'assistant' ? 'model' : role;
      if (message.source.kind !== sourceKind) return finish('invalid', role === 'user' ? 'not_direct_user_source' : 'message_source_mismatch');
      if (role !== 'user') {
        if (event.data.interrupted !== undefined && event.data.interrupted !== true) return finish('unavailable', 'malformed_interrupted_flag');
        if (message.isError !== undefined && typeof message.isError !== 'boolean') return finish('unavailable', 'malformed_error_flag');
        if (event.data.interrupted === true || event.data.error !== undefined || message.isError === true) return finish('invalid', 'failed_or_interrupted_message');
      }
      if (role === 'assistant') {
        if (!nonempty(message.source.provider) || !nonempty(message.source.model)) return finish('unavailable', 'malformed_model_identity');
        if (!Array.isArray(event.data.stream)) return finish('unavailable', 'malformed_assistant_stream');
        for (const entry of event.data.stream) {
          if (!record(entry) || !['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'chunk'].includes(String(entry.type))) return finish('unavailable', 'malformed_assistant_stream');
          if (entry.type === 'chunk') {
            if (!record(entry.chunk) || !nonempty(entry.chunk.type)) return finish('unavailable', 'malformed_assistant_stream');
            if (entry.chunk.type === 'finish') {
              if (!record(entry.chunk.reason) || !['stop', 'tool-calls', 'max-tokens', 'error', 'aborted'].includes(String(entry.chunk.reason.kind))) return finish('unavailable', 'malformed_assistant_finish');
              if (['error', 'aborted'].includes(String(entry.chunk.reason.kind))) return finish('invalid', 'failed_or_interrupted_message');
            }
          }
        }
      }
      if (role === 'tool' && (!nonempty(message.toolCallId) || !nonempty(message.source.callId))) return finish('unavailable', 'malformed_tool_identity');
      if (role === 'tool' && message.toolCallId !== message.source.callId) return finish('invalid', 'tool_call_identity_mismatch');
      const block: unknown = message.content[ref.blockIndex];
      if (!record(block) || block.type !== 'text') return finish('invalid', 'not_a_text_block');
      if (typeof block.text !== 'string') return finish('unavailable', 'malformed_text_block');
      if (!block.text.includes(ref.quote)) return finish('invalid', 'quote_not_found');
      const traceValue = await queryWithSignal(() => query.traceEvent({ sessionId: ref.sessionId, seq: ref.seq }, signal), signal);
      let trace: unknown;
      try { trace = JSON.parse(stableJson(traceValue, maxBytes)); }
      catch (error) { return finish('unavailable', error instanceof ByteLimit ? 'trace_byte_limit' : 'malformed_event_trace'); }
      if (!record(trace) || !header(trace.session)
        || !record(trace.target) || !nonempty(trace.target.sessionId) || !seq(trace.target.seq) || !nonempty(trace.target.type)
        || typeof trace.target.time !== 'number' || !['current', 'shadowed', 'log-only'].includes(String(trace.target.surface))
        || !['replacementChain', 'replacedEventSeqs', 'sourceEventSeqs', 'derivedEventSeqs'].every(key => Array.isArray(trace[key]) && trace[key].every(seq))
        || (trace.replacedBy !== undefined && !seq(trace.replacedBy))) return finish('unavailable', 'malformed_event_trace');
      if (trace.session.id !== ref.sessionId || trace.target.sessionId !== ref.sessionId || trace.target.seq !== ref.seq
        || trace.target.type !== event.type || trace.target.time !== event.time) return finish('invalid', 'trace_identity_mismatch');
      if (trace.session.isSeeded) return finish('unavailable', 'inherited_ancestry_incomplete');
      if (trace.session.version !== identity.version || trace.session.createdAt !== identity.createdAt
        || trace.session.parentSession !== identity.parentSession) return finish('invalid', 'trace_identity_mismatch');
      if ((trace.replacedEventSeqs as unknown[]).length) return finish('invalid', 'replacement_event');
      const tracedSources = trace.sourceEventSeqs as number[];
      if (toolCallSeq === undefined) {
        if (tracedSources.length) return finish('invalid', 'derived_source_event');
      } else if (tracedSources.length !== 1 || tracedSources[0] !== toolCallSeq) return finish('invalid', 'tool_call_trace_link_mismatch');
      if (trace.target.surface === 'log-only') return finish('unavailable', 'trace_surface_mismatch');
      if (toolCallSeq !== undefined) {
        const failure = await verifyToolCall(query, ref.sessionId, toolCallSeq, event, message, identity, maxBytes, signal);
        if (failure) return finish(failure.status, failure.reason);
      }
      signal?.throwIfAborted();
      return { schemaVersion: 1, ref, status: 'verified', independentEvents: 'unknown',
        canonical: { sessionId: ref.sessionId, seq: ref.seq, messageId: message.id, role, sourceKind,
          eventHash: createHash('sha256').update(serialized, 'utf8').digest('hex') },
        chain: [{ sessionId: ref.sessionId, seq: ref.seq }] };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Provider messages may contain raw event data, paths or credentials.
      return finish('unavailable', 'session_query_failed');
    }
  };
}
