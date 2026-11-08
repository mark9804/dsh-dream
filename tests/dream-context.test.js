import assert from 'node:assert/strict';
import test from 'node:test';
import { createDreamContextReader } from '../dist/harness/dream-context.js';

const options = (extra = {}) => ({ sessionId: 'current', sourceSessionIds: [], dreamContextRefs: [{ sessionId: 'current', seq: 40 }], maxDreamContextBytes: 16384, ...extra });
const snapshot = (sources = []) => ({ schemaVersion: 1, snapshotId: 'snap', scope: { sessionId: 'current' }, sources });
const digest = (evidence = []) => ({ schemaVersion: 1, snapshotId: 'snap', episodes: [{ evidence }], coverage: { sourceIds: [], omittedSourceIds: [] } });
function event(seq = 40, role = 'user', text = `public text ${seq}`) {
  const message = { id: `m-${seq}`, role, source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'synthetic', model: 'test' },
    content: [{ type: 'reasoning', text: 'SECRET REASONING' }, { type: 'text', text }] };
  return { seq, type: `${role}/message`, time: seq * 100, surfaceOp: 'append', data: role === 'user' ? message : { message, stream: [] } };
}
function fixture({ config = options(), events = [event(10), event(40, 'assistant'), event(90)], mutateWindow, mutateTrace, read, trace, missing = false } = {}) {
  const calls = [];
  const ctx = { get(name) {
    calls.push({ method: 'get', name });
    assert.equal(this, ctx);
    if (missing) return undefined;
    return {
      async readEvent(request, signal) {
        calls.push({ method: 'readEvent', request, signal });
        const window = { session: { id: request.sessionId, isSeeded: false }, inheritedEventCount: 0,
          target: events.find(item => item.seq === request.seq), events,
          startSeq: events[0]?.seq, endSeq: events.at(-1)?.seq };
        mutateWindow?.(window);
        return read ? read(window, signal) : window;
      },
      async traceEvent(request, signal) {
        calls.push({ method: 'traceEvent', request, signal });
        const target = events.find(item => item.seq === request.seq);
        const value = { session: { id: request.sessionId, isSeeded: false },
          target: { sessionId: request.sessionId, seq: request.seq, type: target?.type, time: target?.time, surface: 'current' },
          replacedEventSeqs: [], sourceEventSeqs: [], replacementChain: [], derivedEventSeqs: [] };
        mutateTrace?.(value);
        return trace ? trace(value, signal) : value;
      },
      readSession() { assert.fail('no full session fallback'); },
      listSessions() { assert.fail('no session listing'); },
      searchEvents() { assert.fail('no semantic fallback'); },
    };
  }, fs: { readText() { assert.fail('no file fallback'); } } };
  return { read: createDreamContextReader(ctx, config), calls };
}

test('reads bounded exact windows with sparse seq and only public role/text', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await f.read(snapshot(), digest(), { signal });
  assert.deepEqual(result.messages, [
    { sessionId: 'current', seq: 10, role: 'user', text: 'public text 10' },
    { sessionId: 'current', seq: 40, role: 'assistant', text: 'public text 40' },
    { sessionId: 'current', seq: 90, role: 'user', text: 'public text 90' },
  ]);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(result.coverage, { requested: 1, included: 3, omitted: 0, unavailable: 0, reasons: ['neighbors_not_evidence'] });
  assert.deepEqual(f.calls, [
    { method: 'get', name: 'sessionQuery' },
    { method: 'readEvent', request: { sessionId: 'current', seq: 40, before: 2, after: 2 }, signal },
    { method: 'traceEvent', request: { sessionId: 'current', seq: 40 }, signal },
  ]);
});

test('authorization is checked before service lookup and cannot be mutated after creation', async () => {
  const config = options({ dreamContextRefs: [{ sessionId: 'private', seq: 40 }] });
  const f = fixture({ config });
  config.sourceSessionIds.push('private');
  const result = await f.read(snapshot(), digest());
  assert.deepEqual(f.calls, []);
  assert.equal(result.coverage.unavailable, 1);
  assert.ok(result.coverage.reasons.includes('session_not_authorized'));
  const allowed = fixture({ config: options({ sourceSessionIds: ['private'], dreamContextRefs: [{ sessionId: 'private', seq: 40 }] }) });
  assert.equal((await allowed.read(snapshot(), digest())).messages.length, 3);
});

test('digest evidence selects only matching verified canonical refs without reading source content', async () => {
  const source = { sourceId: 'source', originals: [
    { status: 'verified', ref: { quote: 'recorded quote' }, canonical: { sessionId: 'current', seq: 40 } },
    { status: 'verified', ref: { quote: 'unrelated' }, canonical: { sessionId: 'current', seq: 90 } },
    { status: 'unavailable', ref: { quote: 'recorded quote' }, canonical: { sessionId: 'current', seq: 90 } },
  ] };
  Object.defineProperty(source, 'content', { get() { assert.fail('must not inspect file content'); } });
  const f = fixture({ config: options({ dreamContextRefs: [] }) });
  const result = await f.read(snapshot([source]), digest([{ sourceId: 'source', quote: 'recorded quote' }]));
  assert.equal(result.coverage.requested, 1);
  assert.equal(result.messages.length, 3);
  assert.equal(f.calls.filter(call => call.method === 'readEvent').length, 1);
});

test('explicit refs are prioritized, selected refs and overlapping windows are deduplicated', async () => {
  const source = { sourceId: 's', originals: Array.from({ length: 20 }, (_, seq) => ({ status: 'verified', ref: { quote: 'q' }, canonical: { sessionId: 'current', seq } })) };
  const f = fixture({ config: options({ dreamContextRefs: [{ sessionId: 'current', seq: 40 }, { sessionId: 'current', seq: 40 }] }) });
  const result = await f.read(snapshot([source]), digest([{ sourceId: 's', quote: 'q' }]));
  assert.equal(result.coverage.requested, 21);
  const requests = f.calls.filter(call => call.method === 'readEvent').map(call => call.request.seq);
  assert.deepEqual(requests, [40, ...Array.from({ length: 15 }, (_, seq) => seq)]);
  assert.equal(result.coverage.omitted, 5);
  assert.ok(result.coverage.reasons.includes('reference_limit'));
  const overlap = fixture({ config: options({ dreamContextRefs: [{ sessionId: 'current', seq: 40 }, { sessionId: 'current', seq: 90 }] }) });
  assert.equal((await overlap.read(snapshot(), digest())).messages.length, 3);
});

test('excludes internal, tool, system, derived and failed messages from neighboring history', async () => {
  const cases = [
    item => { item.type = 'tool/result'; }, item => { item.type = 'system/message'; }, item => { item.type = 'developer/message'; },
    item => { item.type = 'plugin:injected'; }, item => { item.data.source.kind = 'dsh-dream'; },
    item => { item.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 9 }; }, item => { item.sourceEventSeqs = [1]; },
    item => { item.data.interrupted = true; }, item => { item.data.error = { code: 'failed' }; },
  ];
  for (const mutate of cases) {
    const neighbor = event(10); mutate(neighbor);
    const f = fixture({ events: [neighbor, event(40, 'assistant')] });
    const result = await f.read(snapshot(), digest());
    assert.deepEqual(result.messages.map(item => item.seq), [40]);
    assert.equal(result.coverage.omitted, 1);
  }
  const broken = event(10, 'assistant');
  broken.data.stream = [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error' } } }];
  assert.deepEqual((await fixture({ events: [broken, event(40)] }).read(snapshot(), digest())).messages.map(item => item.seq), [40]);
});

test('malformed, forged, oversized-window and inherited Host observations remain unavailable', async () => {
  for (const mutateWindow of [
    value => { value.session.id = 'wrong'; }, value => { value.target = event(41); },
    value => { value.session.isSeeded = true; }, value => { value.inheritedEventCount = 2; },
    value => { delete value.inheritedEventCount; }, value => { value.events = [...value.events].reverse(); },
    value => { value.startSeq = 999; }, value => { value.events = [event(0), event(1), event(2), event(3), event(40), event(90)]; },
  ]) {
    const result = await fixture({ mutateWindow }).read(snapshot(), digest());
    assert.deepEqual(result.messages, []);
    assert.equal(result.coverage.unavailable, 1);
  }
  for (const mutateTrace of [
    value => { value.target.seq++; }, value => { value.target.sessionId = 'wrong'; }, value => { value.target.type = 'wrong'; },
    value => { value.target.time++; }, value => { value.session.isSeeded = true; },
    value => { value.sourceEventSeqs = [1]; }, value => { value.replacedEventSeqs = [1]; },
    value => { value.target.surface = 'shadowed'; }, value => { value.target.surface = 'log-only'; }, value => { value.replacedBy = 999; },
  ]) {
    const result = await fixture({ mutateTrace }).read(snapshot(), digest());
    assert.deepEqual(result.messages, []);
    assert.equal(result.coverage.unavailable, 1);
  }
});

test('missing service or provider failure returns coverage without leaking errors or blocking facts', async () => {
  for (const settings of [{ missing: true }, { read() { throw new Error('private path or secret'); } }, { trace() { throw new Error('private path or secret'); } }]) {
    const result = await fixture(settings).read(snapshot(), digest());
    assert.deepEqual(result.messages, []);
    assert.equal(result.coverage.unavailable, 1);
    assert.equal(JSON.stringify(result).includes('private path'), false);
  }
  const none = fixture({ config: options({ dreamContextRefs: [] }) });
  assert.deepEqual((await none.read(snapshot(), digest())).coverage.reasons, ['no_context_references']);
  assert.deepEqual(none.calls, []);
});

test('context budget omits whole messages, counts UTF-8 and bounds serialized output', async () => {
  const long = '海'.repeat(1000);
  const f = fixture({ config: options({ maxDreamContextBytes: 512 }), events: [event(10, 'user', long), event(40, 'assistant', 'short'), event(90, 'user', 'tail')] });
  const result = await f.read(snapshot(), digest());
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512);
  assert.ok(result.messages.every(item => item.text === 'short' || item.text === 'tail'));
  assert.equal(result.coverage.omitted, 1);
  assert.ok(result.coverage.reasons.includes('message_byte_limit'));
  const escaped = fixture({ config: options({ maxDreamContextBytes: 512 }), events: [event(40, 'user', '"'.repeat(300))] });
  const escapedResult = await escaped.read(snapshot(), digest());
  assert.deepEqual(escapedResult.messages, []);
  assert.ok(Buffer.byteLength(JSON.stringify(escapedResult)) <= 512);
});

test('input scope mismatch is fail closed before I/O', async () => {
  const f = fixture();
  const wrong = snapshot(); wrong.scope.sessionId = 'other';
  const result = await f.read(wrong, digest());
  assert.deepEqual(result.messages, []);
  assert.ok(result.coverage.reasons.includes('input_scope_mismatch'));
  assert.deepEqual(f.calls, []);
});

test('cancellation propagates exact reason only after started read or trace drains', async () => {
  const stop = new Error('cancel synthetic context');
  const f = fixture();
  await assert.rejects(f.read(snapshot(), digest(), { signal: AbortSignal.abort(stop) }), error => error === stop);
  assert.deepEqual(f.calls, []);
  for (const stage of ['read', 'trace']) {
    const controller = new AbortController();
    let release;
    const waiting = fixture({ [stage]: value => new Promise(resolve => { release = () => resolve(value); }) });
    let settled = false;
    const pending = waiting.read(snapshot(), digest(), { signal: controller.signal }).finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(stop);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'must drain the actual Host read before returning cancellation');
    release();
    await assert.rejects(pending, error => error === stop);
    assert.ok(waiting.calls.filter(call => call.request).every(call => call.signal === controller.signal));
    if (stage === 'read') assert.equal(waiting.calls.some(call => call.method === 'traceEvent'), false);
  }
});

test('rejects invalid config budget and ref shape at construction', () => {
  for (const maxDreamContextBytes of [511, 65537, 1.5, NaN]) assert.throws(() => createDreamContextReader({}, options({ maxDreamContextBytes })), /maxDreamContextBytes/);
  assert.throws(() => createDreamContextReader({}, options({ dreamContextRefs: Array.from({ length: 17 }, () => ({ sessionId: 'current', seq: 1 })) })), /references/);
  assert.throws(() => createDreamContextReader({}, options({ dreamContextRefs: [{ sessionId: 'current', seq: -1 }] })), /references/);
});
