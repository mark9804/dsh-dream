import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createOriginalSourceVerifier } from '../dist/harness/original-source.js';

const reference = { sessionId: 'authorized', seq: 40, blockIndex: 0, quote: 'synthetic recorded result' };
const header = () => ({ id: 'authorized', version: 4, createdAt: 10, isSeeded: false });
function records() {
  // Mirrors rc.1 dsh-tools BatchSettlement.start/commit. Sparse sequences are
  // event identities, not array offsets. The result does not carry a tool name.
  const call = { type: 'tool/call', seq: 11, time: 100, data: { turn: 2, step: 3, callId: 'call-1', name: 'synthetic_read', arguments: '{"path":"synthetic-only"}' } };
  const result = { type: 'tool/result', seq: 40, time: 105, surfaceOp: 'append', sourceEventSeqs: [11], data: {
    turn: 2, step: 3,
    message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1',
      content: [{ type: 'text', text: 'prefix synthetic recorded result suffix not disclosed' }] },
  } };
  return { call, result };
}
function fixture({ change, read, trace, maxOriginalBytes = 8192, sourceSessionIds = ['authorized'], sessionId = 'current' } = {}) {
  const events = records();
  change?.(events);
  const calls = [];
  const windows = new Map(Object.values(events).map(event => [event.seq, { session: header(), inheritedEventCount: 0,
    target: event, events: [event], startSeq: event.seq, endSeq: event.seq }]));
  const traces = new Map(Object.values(events).map(event => [event.seq, { session: header(),
    target: { sessionId: 'authorized', seq: event.seq, time: event.time, type: event.type, surface: event.type === 'tool/call' ? 'log-only' : 'current' },
    replacedEventSeqs: [], sourceEventSeqs: event.sourceEventSeqs ?? [], replacementChain: [],
    derivedEventSeqs: event === events.call ? [events.result.seq] : [],
  }]));
  const service = {
    async readEvent(request, signal) {
      calls.push({ method: 'readEvent', request, signal });
      const value = windows.get(request.seq);
      return read ? read(request, value, signal) : value;
    },
    async traceEvent(request, signal) {
      calls.push({ method: 'traceEvent', request, signal });
      const value = traces.get(request.seq);
      return trace ? trace(request, value, signal) : value;
    },
    readSession() { assert.fail('No full log reads'); }, listEvents() { assert.fail('No event scans'); },
    listSessions() { assert.fail('No session listing'); }, searchEvents() { assert.fail('No semantic search'); },
  };
  const context = { get(key) { assert.equal(key, 'sessionQuery'); calls.push({ method: 'get' }); return service; } };
  return { verify: createOriginalSourceVerifier(context, { sessionId, sourceSessionIds, maxOriginalBytes }), calls, events, windows, traces };
}
const denied = (value, status, reason) => {
  assert.equal(value.status, status);
  if (reason) assert.equal(value.reason, reason);
  assert.equal(value.canonical, undefined);
  assert.equal(value.chain, undefined);
  assert.equal(value.independentEvents, 'unknown');
};

test('rc.1 native tool/result verifies its single exact call link with four bounded reads', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const receipt = await f.verify(reference, { signal });
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(receipt.ref, reference);
  assert.equal(receipt.canonical.role, 'tool');
  assert.equal(receipt.canonical.sourceKind, 'tool');
  assert.equal(receipt.canonical.messageId, 'result-1');
  assert.equal(receipt.canonical.seq, 40);
  assert.equal(receipt.independentEvents, 'unknown');
  assert.deepEqual(receipt.chain, [{ sessionId: 'authorized', seq: 40 }], 'call is association, not an inherited original or extra evidence');
  assert.deepEqual(f.calls, [
    { method: 'get' },
    { method: 'readEvent', request: { sessionId: 'authorized', seq: 40, before: 0, after: 0 }, signal },
    { method: 'traceEvent', request: { sessionId: 'authorized', seq: 40 }, signal },
    { method: 'readEvent', request: { sessionId: 'authorized', seq: 11, before: 0, after: 0 }, signal },
    { method: 'traceEvent', request: { sessionId: 'authorized', seq: 11 }, signal },
  ]);
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  assert.equal(receipt.canonical.eventHash, createHash('sha256').update(JSON.stringify(sorted(f.events.result))).digest('hex'));
  assert.equal(JSON.stringify(receipt).includes('suffix not disclosed'), false);
  assert.equal(JSON.stringify(receipt).includes('synthetic-only'), false);
});

test('call/result allowlist precedes lookup and every extra read stays in the authorized same session', async () => {
  const rejected = fixture({ sourceSessionIds: [] });
  denied(await rejected.verify(reference), 'invalid', 'session_not_authorized');
  assert.deepEqual(rejected.calls, []);
  const allowed = fixture({ sessionId: 'authorized', sourceSessionIds: [] });
  assert.equal((await allowed.verify(reference)).status, 'verified');
  assert.ok(allowed.calls.every(call => !call.request || call.request.sessionId === 'authorized'));
});

test('only a single backward numeric tool call reference is eligible', async () => {
  for (const links of [[11, 12], [11, 11], [40], [41]]) {
    const f = fixture({ change: ({ result }) => { result.sourceEventSeqs = links; } });
    denied(await f.verify(reference), 'invalid');
    assert.equal(f.calls.some(call => call.request?.seq === 11), false);
  }
  for (const links of [['11'], [-1], [1.5], [{ sessionId: 'not-authorized', seq: 11 }]]) {
    denied(await fixture({ change: ({ result }) => { result.sourceEventSeqs = links; } }).verify(reference), 'unavailable', 'malformed_source_event_links');
  }
});

test('non-tool source links and tool replacement/failed results retain their original rejection', async () => {
  for (const change of [
    ({ result }) => { result.type = 'user/message'; result.data = { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: reference.quote }] }; },
    ({ result }) => { result.type = 'assistant/message'; },
    ({ result }) => { result.surfaceOp = { op: 'replace', startSeq: 1, endSeq: 10 }; },
    ({ result }) => { result.data.message.isError = true; },
    ({ result }) => { result.data.error = { code: 'FAILED', name: 'Error' }; },
    ({ result }) => { result.data.interrupted = true; },
    ({ result }) => { result.data.message.role = 'assistant'; },
    ({ result }) => { result.data.message.source.kind = 'model'; },
    ({ result }) => { result.data.message.source.callId = 'forged'; },
  ]) {
    const f = fixture({ change });
    denied(await f.verify(reference), 'invalid');
    assert.equal(f.calls.some(call => call.request?.seq === 11), false, 'no need to inspect call after a rejected result');
  }
});

test('result trace source links must exactly match the raw sole call link', async () => {
  for (const sourceEventSeqs of [[], [12], [11, 12], [11, 11]]) {
    const f = fixture(); f.traces.get(40).sourceEventSeqs = sourceEventSeqs;
    denied(await f.verify(reference), 'invalid', 'tool_call_trace_link_mismatch');
    assert.equal(f.calls.some(call => call.request?.seq === 11), false);
  }
  const extra = fixture(); extra.traces.get(40).replacedEventSeqs = [2];
  denied(await extra.verify(reference), 'invalid', 'replacement_event');
});

test('a linked summary, user message or unrelated tool/call is not an original result association', async () => {
  for (const change of [
    ({ call }) => { call.type = 'user/message'; },
    ({ call }) => { call.type = 'tool/result'; },
    ({ call }) => { call.type = 'plugin:summary'; },
    ({ call }) => { call.data.callId = 'different'; },
    ({ call }) => { call.data.turn++; },
    ({ call }) => { call.data.step++; },
    ({ call }) => { call.time = 106; },
    ({ call }) => { call.surfaceOp = 'append'; },
    ({ call }) => { call.sourceEventSeqs = [1]; },
    ({ call }) => { call.sourceEventSeqs = []; },
    ({ call }) => { call.data.error = { code: 'FAILED' }; },
  ]) denied(await fixture({ change }).verify(reference), 'invalid');
  const equalTime = fixture({ change: ({ call, result }) => { call.time = result.time; } });
  assert.equal((await equalTime.verify(reference)).status, 'verified', 'seq establishes call-before-result even within one clock tick');
});

test('call names arguments and turn/step shape must be available, without inventing result name fields', async () => {
  for (const change of [
    ({ call }) => { delete call.data.name; }, ({ call }) => { call.data.name = ''; }, ({ call }) => { call.data.name = ' '; },
    ({ call }) => { call.data.arguments = {}; }, ({ call }) => { delete call.data.callId; },
    ({ call }) => { call.data.turn = -1; }, ({ call }) => { call.data.step = 2.5; },
    ({ result }) => { delete result.data.turn; }, ({ result }) => { delete result.data.step; },
  ]) denied(await fixture({ change }).verify(reference), 'unavailable', 'malformed_tool_call_data');
  assert.equal((await fixture().verify(reference)).status, 'verified', 'real Host result has no name field');
});

test('call window must have exact session header sequence type and complete noninherited ancestry', async () => {
  for (const mutate of [
    value => { value.session.id = 'not-authorized'; }, value => { value.session.createdAt++; }, value => { value.session.version++; },
    value => { value.target.seq++; }, value => { value.target.type = 'tool/result'; },
  ]) {
    const f = fixture({ read: (request, value) => { if (request.seq === 11) mutate(value); return value; } });
    denied(await f.verify(reference), 'invalid');
  }
  for (const mutate of [value => { value.session.isSeeded = true; value.session.parentSession = 'not-authorized'; }, value => { value.inheritedEventCount = 1; }]) {
    const f = fixture({ read: (request, value) => { if (request.seq === 11) mutate(value); return value; } });
    denied(await f.verify(reference), 'unavailable', 'inherited_ancestry_incomplete');
    assert.ok(f.calls.every(call => !call.request || call.request.sessionId === 'authorized'));
  }
});

test('missing or malformed call read/trace is unavailable, not a partial verified proof', async () => {
  for (const read of [
    (request, value) => request.seq === 11 ? undefined : value,
    (request, value) => request.seq === 11 ? {} : value,
    (request, value) => { if (request.seq === 11) throw new Error('private provider details'); return value; },
    (request, value) => { if (request.seq === 11) value.target.data = null; return value; },
    (request, value) => { if (request.seq === 11) delete value.inheritedEventCount; return value; },
  ]) {
    const receipt = await fixture({ read }).verify(reference);
    denied(receipt, 'unavailable');
    assert.equal(JSON.stringify(receipt).includes('private provider'), false);
  }
  for (const trace of [
    (request, value) => request.seq === 11 ? undefined : value,
    (request, value) => { if (request.seq === 11) delete value.derivedEventSeqs; return value; },
    (request, value) => { if (request.seq === 11) throw new Error('unavailable'); return value; },
  ]) denied(await fixture({ trace }).verify(reference), 'unavailable');
});

test('call trace identity and log-only shape must match exactly with a reverse link to this result', async () => {
  for (const mutate of [
    value => { value.session.id = 'forged'; }, value => { value.session.createdAt++; },
    value => { value.target.sessionId = 'forged'; }, value => { value.target.seq++; },
    value => { value.target.type = 'user/message'; }, value => { value.target.time++; },
    value => { value.target.surface = 'current'; }, value => { value.sourceEventSeqs = [1]; },
    value => { value.replacedEventSeqs = [1]; }, value => { value.replacedBy = 99; },
    value => { value.replacementChain = [99]; }, value => { value.derivedEventSeqs = []; },
    value => { value.derivedEventSeqs = [39]; },
  ]) {
    const f = fixture(); mutate(f.traces.get(11));
    denied(await f.verify(reference), 'invalid');
  }
  const seeded = fixture(); seeded.traces.get(11).session.isSeeded = true;
  denied(await seeded.verify(reference), 'unavailable', 'inherited_ancestry_incomplete');
  const reused = fixture(); reused.traces.get(11).derivedEventSeqs.push(80);
  assert.equal((await reused.verify(reference)).status, 'verified', 'other consumers do not establish a second tool result or independent evidence');
});

test('linked tool result retains exact occurrence even after later surface shadowing', async () => {
  const f = fixture();
  const trace = f.traces.get(40);
  trace.target.surface = 'shadowed'; trace.replacedBy = 90; trace.replacementChain = [90]; trace.derivedEventSeqs = [90];
  assert.equal((await f.verify(reference)).status, 'verified');
});

test('linked call and call trace retain their UTF-8 serialized budgets', async () => {
  const oversized = fixture({ maxOriginalBytes: 1024, change: ({ call }) => { call.data.arguments = '海'.repeat(500); } });
  denied(await oversized.verify(reference), 'unavailable', 'tool_call_byte_limit');
  assert.equal(oversized.calls.some(call => call.method === 'traceEvent' && call.request.seq === 11), false);
  const trace = fixture({ maxOriginalBytes: 1024 });
  trace.traces.get(11).derivedEventSeqs = [40, ...Array.from({ length: 1000 }, (_, i) => i + 100)];
  denied(await trace.verify(reference), 'unavailable', 'tool_call_trace_byte_limit');
});

test('linked call snapshot is detached before trace awaits and receipt keeps only result identity', async () => {
  let release;
  const f = fixture({ trace: (request, value) => request.seq === 11 ? new Promise(resolve => { release = () => resolve(value); }) : value });
  const pending = f.verify(reference);
  await new Promise(resolve => setImmediate(resolve));
  f.events.call.data.callId = 'mutated-late';
  release();
  assert.equal((await pending).status, 'verified');
});

test('cancellation reaches linked call read and trace and never launches subsequent I/O', async () => {
  const stopped = new Error('synthetic cancellation');
  for (const stage of ['read', 'trace']) {
    const controller = new AbortController();
    const f = fixture({ [stage]: (request, value) => request.seq === 11 ? new Promise(() => {}) : value });
    const pending = f.verify(reference, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(stopped);
    await assert.rejects(pending, error => error === stopped);
    assert.ok(f.calls.filter(call => call.request).every(call => call.signal === controller.signal));
    if (stage === 'read') assert.equal(f.calls.some(call => call.method === 'traceEvent' && call.request.seq === 11), false);
  }
});

test('legacy tool results with no source links keep the original exact occurrence behavior', async () => {
  const f = fixture({ change: ({ result }) => { delete result.sourceEventSeqs; } });
  assert.equal((await f.verify(reference)).status, 'verified');
  assert.deepEqual(f.calls.filter(call => call.request).map(call => call.request.seq), [40, 40]);
});
