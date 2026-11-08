import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createOriginalSourceVerifier } from '../dist/harness/original-source.js';

const ref = (overrides = {}) => ({ sessionId: 'current', seq: 41, blockIndex: 1, quote: 'exact recorded words', ...overrides });
const header = (overrides = {}) => ({ version: 4, id: 'current', createdAt: 10, isSeeded: false, ...overrides });
function originalEvent(role = 'user') {
  const source = role === 'assistant' ? { kind: 'model', provider: 'synthetic', model: 'test' }
    : role === 'tool' ? { kind: 'tool', callId: 'call-1' } : { kind: 'user' };
  const message = { id: `message-${role}`, role, source, content: [
    { type: 'reasoning', text: 'not a text block' },
    { type: 'text', text: 'Prefix: exact recorded words. Additional raw private context must stay out of receipt.' },
  ] };
  if (role === 'tool') message.toolCallId = 'call-1';
  return { type: role === 'tool' ? 'tool/result' : `${role}/message`, seq: 41, time: 123, surfaceOp: 'append',
    data: role === 'user' ? message : { turn: 2, step: 1, message, ...(role === 'assistant' ? { stream: [] } : {}) } };
}
function fixture({ event = originalEvent(), session = header(), inheritedEventCount = 0, scope = {}, changeTrace, read, trace } = {}) {
  const calls = [];
  const window = { session, inheritedEventCount, target: event, events: [event], startSeq: event.seq, endSeq: event.seq };
  const traced = { session: structuredClone(session), target: { sessionId: session.id, seq: event.seq, type: event.type, time: event.time, surface: 'current' },
    replacementChain: [], replacedEventSeqs: [], sourceEventSeqs: [], derivedEventSeqs: [] };
  changeTrace?.(traced);
  const service = {
    async readEvent(request, signal) { calls.push({ method: 'readEvent', request, signal }); return read ? read(request, signal, window) : window; },
    async traceEvent(request, signal) { calls.push({ method: 'traceEvent', request, signal }); return trace ? trace(request, signal, traced) : traced; },
    listSessions() { assert.fail('Never list sessions'); },
    searchSessions() { assert.fail('Never search sessions'); },
    listEvents() { assert.fail('Never list events'); },
    readSession() { assert.fail('Never read a whole session'); },
  };
  const ctx = { get(key) { calls.push({ method: 'get', key }); assert.equal(this, ctx); assert.equal(key, 'sessionQuery'); return service; } };
  const config = { sessionId: 'current', sourceSessionIds: [], maxOriginalBytes: 8192, ...scope };
  return { verify: createOriginalSourceVerifier(ctx, config), calls, window, traced, config, service };
}
const notVerified = (receipt, status, reason) => {
  assert.equal(receipt.status, status);
  if (reason) assert.equal(receipt.reason, reason);
  assert.equal(receipt.canonical, undefined);
  assert.equal(receipt.chain, undefined);
  assert.equal(receipt.independentEvents, 'unknown');
};

for (const role of ['user', 'assistant', 'tool']) {
  test(`verifies exact ${role} recorded occurrence with its real role and bounded receipt`, async () => {
    const { verify, calls } = fixture({ event: originalEvent(role) });
    const signal = new AbortController().signal;
    const receipt = await verify(ref(), { signal });
    assert.equal(receipt.status, 'verified');
    assert.deepEqual(receipt.ref, ref());
    assert.deepEqual(receipt.chain, [{ sessionId: 'current', seq: 41 }]);
    assert.equal(receipt.independentEvents, 'unknown');
    assert.equal(receipt.canonical.role, role);
    assert.equal(receipt.canonical.sourceKind, role === 'assistant' ? 'model' : role);
    assert.equal(receipt.canonical.messageId, `message-${role}`);
    assert.equal(receipt.canonical.sessionId, 'current');
    assert.equal(receipt.canonical.seq, 41);
    assert.match(receipt.canonical.eventHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(receipt).includes('Additional raw private context'), false);
    assert.deepEqual(calls, [
      { method: 'get', key: 'sessionQuery' },
      { method: 'readEvent', request: { sessionId: 'current', seq: 41, before: 0, after: 0 }, signal },
      { method: 'traceEvent', request: { sessionId: 'current', seq: 41 }, signal },
    ]);
  });
}

test('allowlist is checked before any service lookup or I/O, with explicit external sources only', async () => {
  const current = fixture();
  notVerified(await current.verify(ref({ sessionId: 'private-other' })), 'invalid', 'session_not_authorized');
  assert.deepEqual(current.calls, []);
  const allowed = fixture({ session: header({ id: 'authorized-source' }), scope: { sourceSessionIds: ['authorized-source'] } });
  assert.equal((await allowed.verify(ref({ sessionId: 'authorized-source' }))).status, 'verified');
  allowed.config.sourceSessionIds.push('added-after-construction');
  notVerified(await allowed.verify(ref({ sessionId: 'added-after-construction' })), 'invalid', 'session_not_authorized');
});

test('ref shape is defensively checked without I/O and reflects no arbitrary properties', async () => {
  for (const value of [null, undefined, [], {}, ref({ seq: -1 }), ref({ seq: 1.5 }), ref({ seq: Number.MAX_SAFE_INTEGER + 1 }),
    ref({ blockIndex: -1 }), ref({ blockIndex: 1.5 }), ref({ quote: '' }), ref({ quote: 1 }), ref({ sessionId: '' })]) {
    const { verify, calls } = fixture();
    notVerified(await verify(value), 'invalid', 'invalid_reference');
    assert.deepEqual(calls, []);
  }
  const value = ref({ untrustedExtra: 'do not echo me' });
  const receipt = await fixture().verify(value);
  assert.deepEqual(receipt.ref, ref());
  assert.notEqual(receipt.ref, value);
});

test('forged sequence and session header do not prove a different original', async () => {
  const wrongSeq = fixture();
  notVerified(await wrongSeq.verify(ref({ seq: 42 })), 'invalid', 'event_sequence_mismatch');
  assert.equal(wrongSeq.calls.some(call => call.method === 'traceEvent'), false);
  notVerified(await fixture({ session: header({ id: 'someone-else' }) }).verify(ref()), 'invalid', 'session_header_mismatch');
});

test('quote matching is exact literal text in the indexed block, not normalization or semantic matching', async () => {
  for (const overrides of [
    { quote: 'Exact recorded words' }, { quote: 'exact  recorded words' }, { quote: 'recorded paraphrase' },
    { quote: 'exact recorded words. Additional', blockIndex: 0 }, { blockIndex: 5 },
  ]) notVerified(await fixture().verify(ref(overrides)), 'invalid');
  const event = originalEvent();
  event.data.content[1].text = 'caf\u00e9';
  notVerified(await fixture({ event }).verify(ref({ quote: 'cafe\u0301' })), 'invalid', 'quote_not_found');
  event.data.content = [{ type: 'text', text: 'exact ' }, { type: 'text', text: 'recorded words' }];
  notVerified(await fixture({ event }).verify(ref()), 'invalid', 'quote_not_found');
});

test('system/developer/log-only events, role mismatches and internal user followups are not originals', async () => {
  for (const type of ['system/message', 'developer/message', 'assistant/attempt', 'plugin:other/summary']) {
    const event = originalEvent(); event.type = type;
    notVerified(await fixture({ event }).verify(ref()), 'invalid', 'unsupported_event_type');
  }
  for (const kind of ['dsh-dream', 'system-prompt', 'model', 'agent-followup']) {
    const event = originalEvent(); event.data.source.kind = kind;
    notVerified(await fixture({ event }).verify(ref()), 'invalid', 'not_direct_user_source');
  }
  for (const role of ['assistant', 'tool', 'system', 'developer']) {
    const event = originalEvent(); event.data.role = role;
    notVerified(await fixture({ event }).verify(ref()), 'invalid', 'message_role_mismatch');
  }
  const assistant = originalEvent('assistant'); assistant.data.message.source.kind = 'user';
  notVerified(await fixture({ event: assistant }).verify(ref()), 'invalid', 'message_source_mismatch');
});

test('replacement nodes and derived source links are rejected from both raw event and trace', async () => {
  const event = originalEvent(); event.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 20 };
  notVerified(await fixture({ event }).verify(ref()), 'invalid', 'replacement_event');
  const derived = originalEvent(); derived.sourceEventSeqs = [2];
  notVerified(await fixture({ event: derived }).verify(ref()), 'invalid', 'derived_source_event');
  notVerified(await fixture({ changeTrace: trace => { trace.replacedEventSeqs = [2]; } }).verify(ref()), 'invalid', 'replacement_event');
  notVerified(await fixture({ changeTrace: trace => { trace.sourceEventSeqs = [2]; } }).verify(ref()), 'invalid', 'derived_source_event');
  const old = fixture({ changeTrace: trace => { trace.target.surface = 'shadowed'; trace.replacedBy = 77; trace.replacementChain = [77]; trace.derivedEventSeqs = [88]; } });
  assert.equal((await old.verify(ref())).status, 'verified', 'shadowing the original does not erase its exact raw occurrence');
});

test('tool failures, interrupted assistants and stream failures cannot produce proof', async () => {
  for (const change of [
    event => { event.data.error = { name: 'Error', code: 'FAILED' }; },
    event => { event.data.message.isError = true; },
    event => { event.data.interrupted = true; },
  ]) {
    for (const role of ['assistant', 'tool']) {
      const event = originalEvent(role); change(event);
      notVerified(await fixture({ event }).verify(ref()), 'invalid', 'failed_or_interrupted_message');
    }
  }
  for (const kind of ['error', 'aborted']) {
    const event = originalEvent('assistant');
    event.data.stream = [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind } } }];
    notVerified(await fixture({ event }).verify(ref()), 'invalid', 'failed_or_interrupted_message');
  }
  const event = originalEvent('tool'); event.data.message.source.callId = 'another-call';
  notVerified(await fixture({ event }).verify(ref()), 'invalid', 'tool_call_identity_mismatch');
});

test('malformed model identity and malformed assistant streams remain unavailable', async () => {
  for (const mutate of [
    event => { delete event.data.message.source.model; }, event => { delete event.data.message.source.provider; },
    event => { event.data.stream = null; }, event => { event.data.stream = [{ type: 'unknown' }]; },
    event => { event.data.stream = [{ type: 'chunk', chunk: null }]; },
    event => { event.data.stream = [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'unknown' } } }]; },
  ]) {
    const event = originalEvent('assistant'); mutate(event);
    notVerified(await fixture({ event }).verify(ref()), 'unavailable');
  }
});

test('trace must bind to the same session, sequence, event type and event time', async () => {
  for (const changeTrace of [
    trace => { trace.session.id = 'forged-header'; }, trace => { trace.target.sessionId = 'forged-target'; },
    trace => { trace.target.seq++; }, trace => { trace.target.type = 'assistant/message'; }, trace => { trace.target.time++; },
  ]) notVerified(await fixture({ changeTrace }).verify(ref()), 'invalid', 'trace_identity_mismatch');
  notVerified(await fixture({ changeTrace: trace => { trace.target.surface = 'log-only'; } }).verify(ref()), 'unavailable', 'trace_surface_mismatch');
});

test('inherited ancestry fails closed without treating seq as prefix ordinal or reading parents', async () => {
  for (const options of [
    { session: header({ isSeeded: true, parentSession: 'not-authorized-parent' }), inheritedEventCount: 2 },
    { session: header({ isSeeded: true, parentSession: 'allowed-parent' }), inheritedEventCount: 0, scope: { sourceSessionIds: ['allowed-parent'] } },
    { inheritedEventCount: 9999 },
    { changeTrace: trace => { trace.session.isSeeded = true; trace.session.parentSession = 'not-authorized-parent'; } },
  ]) {
    const { verify, calls } = fixture(options);
    notVerified(await verify(ref()), 'unavailable', 'inherited_ancestry_incomplete');
    assert.ok(calls.every(call => !call.request || call.request.sessionId === 'current'));
    assert.ok(calls.length <= 3);
  }
});

test('missing optional service, service failures and malformed Host data are unavailable not false proof', async () => {
  for (const ctx of [{}, { get: () => undefined }, { get: () => ({ readEvent() {} }) }, { get() { throw new Error('private-provider-detail'); } }]) {
    const receipt = await createOriginalSourceVerifier(ctx, { sessionId: 'current', sourceSessionIds: [], maxOriginalBytes: 8192 })(ref());
    notVerified(receipt, 'unavailable');
    assert.equal(JSON.stringify(receipt).includes('private-provider-detail'), false);
  }
  for (const read of [() => undefined, () => null, () => ({}), () => { throw new Error('private-log-detail'); },
    (_request, _signal, window) => ({ ...window, inheritedEventCount: undefined }),
    (_request, _signal, window) => ({ ...window, session: { id: 'current' } }),
  ]) notVerified(await fixture({ read }).verify(ref()), 'unavailable');
  for (const trace of [() => undefined, () => ({}), () => { throw new Error('private trace data'); }]) {
    notVerified(await fixture({ trace }).verify(ref()), 'unavailable');
  }
  for (const mutate of [
    event => { delete event.data.source; }, event => { delete event.data.id; }, event => { delete event.time; },
    event => { event.surfaceOp = 'unknown'; }, event => { event.data.content[1].text = 3; },
    event => { event.sourceEventSeqs = 'oops'; }, event => { event.data.circular = event; },
    event => { event.data.unsupported = undefined; },
  ]) {
    const event = originalEvent(); mutate(event);
    notVerified(await fixture({ event }).verify(ref()), 'unavailable');
  }
  for (const changeTrace of [trace => { delete trace.sourceEventSeqs; }, trace => { trace.replacementChain = [-1]; }, trace => { delete trace.session.isSeeded; }]) {
    notVerified(await fixture({ changeTrace }).verify(ref()), 'unavailable', 'malformed_event_trace');
  }
});

test('UTF-8 serialized byte caps reject huge quotes before I/O and huge events before trace', async () => {
  const small = fixture({ scope: { maxOriginalBytes: 128 } });
  const oversized = await small.verify(ref({ quote: '\u6d77'.repeat(50) }));
  notVerified(oversized, 'invalid', 'reference_byte_limit');
  assert.equal(oversized.ref.quote, '');
  assert.deepEqual(small.calls, []);
  const event = originalEvent(); event.data.content.push({ type: 'text', text: '\u6d77'.repeat(1000) });
  const large = fixture({ event, scope: { maxOriginalBytes: 1024 } });
  notVerified(await large.verify(ref()), 'unavailable', 'event_byte_limit');
  assert.equal(large.calls.some(call => call.method === 'traceEvent'), false);
  const trace = fixture({ scope: { maxOriginalBytes: 1024 }, changeTrace: value => { value.derivedEventSeqs = Array.from({ length: 1000 }, (_, i) => i); } });
  notVerified(await trace.verify(ref()), 'unavailable', 'trace_byte_limit');
  const exactEvent = originalEvent();
  const bytes = Buffer.byteLength(JSON.stringify(exactEvent), 'utf8');
  assert.equal((await fixture({ event: exactEvent, scope: { maxOriginalBytes: bytes } }).verify(ref())).status, 'verified');
  notVerified(await fixture({ event: exactEvent, scope: { maxOriginalBytes: bytes - 1 } }).verify(ref()), 'unavailable', 'event_byte_limit');
});

test('hash covers stable complete event, not just quote, and ignores object property order', async () => {
  const firstEvent = originalEvent();
  const first = await fixture({ event: firstEvent }).verify(ref());
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const reordered = await fixture({ event: reorder(firstEvent) }).verify(ref());
  assert.equal(reordered.canonical.eventHash, first.canonical.eventHash);
  const sorted = value => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  assert.equal(first.canonical.eventHash, createHash('sha256').update(JSON.stringify(sorted(firstEvent))).digest('hex'));
  for (const change of [event => { event.time++; }, event => { event.data.id += '-changed'; },
    event => { event.data.content[1].text += ' more unquoted text'; }, event => { event.data.source.origin = 'extra full data'; },
  ]) {
    const event = originalEvent(); change(event);
    const changed = await fixture({ event }).verify(ref());
    assert.equal(changed.status, 'verified');
    assert.notEqual(changed.canonical.eventHash, first.canonical.eventHash);
  }
});

test('ref and raw event snapshots cannot be swapped while trace is pending', async () => {
  const input = ref();
  let release;
  const f = fixture({ trace: (_request, _signal, value) => new Promise(resolve => { release = () => resolve(value); }) });
  const result = f.verify(input);
  await new Promise(resolve => setImmediate(resolve));
  input.sessionId = 'not-authorized'; input.quote = 'different quote';
  f.window.target.data.content[1].text = 'mutated after raw read';
  release();
  const receipt = await result;
  assert.deepEqual(receipt.ref, ref());
  assert.equal(receipt.status, 'verified');
  const expected = await fixture().verify(ref());
  assert.equal(receipt.canonical.eventHash, expected.canonical.eventHash);
});

test('pre-abort and in-flight cancellation propagate exact reason and never return false unavailability', async () => {
  const stop = new Error('synthetic cancellation');
  const before = fixture();
  await assert.rejects(before.verify(ref(), { signal: AbortSignal.abort(stop) }), error => error === stop);
  assert.deepEqual(before.calls, []);
  for (const stage of ['read', 'trace']) {
    const controller = new AbortController();
    const f = fixture({ [stage]: () => new Promise(() => {}) });
    const pending = f.verify(ref(), { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(stop);
    await assert.rejects(pending, error => error === stop);
    for (const call of f.calls.filter(call => call.request)) assert.equal(call.signal, controller.signal);
    if (stage === 'read') assert.equal(f.calls.some(call => call.method === 'traceEvent'), false);
  }
  const controller = new AbortController();
  const during = fixture({ read: (_request, _signal, window) => { controller.abort(stop); return window; } });
  await assert.rejects(during.verify(ref(), { signal: controller.signal }), error => error === stop);
  assert.equal(during.calls.some(call => call.method === 'traceEvent'), false);
  const backendAbort = new DOMException('backend cancelled', 'AbortError');
  await assert.rejects(fixture({ read: () => { throw backendAbort; } }).verify(ref()), error => error === backendAbort);
});

test('configuration rejects invalid byte budgets and authorization shapes', () => {
  for (const maxOriginalBytes of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createOriginalSourceVerifier({}, { sessionId: 'current', sourceSessionIds: [], maxOriginalBytes }), /maxOriginalBytes/);
  }
  for (const config of [{ sessionId: '', sourceSessionIds: [] }, { sessionId: 'current', sourceSessionIds: null }, { sessionId: 'current', sourceSessionIds: [''] }]) {
    assert.throws(() => createOriginalSourceVerifier({}, { ...config, maxOriginalBytes: 8192 }), /authorization/);
  }
});
