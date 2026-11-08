import assert from 'node:assert/strict';
import test from 'node:test';
import { createInternalTurnCompletion } from '../dist/harness/internal-turns.js';
import { createHostControl } from '../dist/harness/control.js';
import { registerTools } from '../dist/harness/tools.js';

function fixture() {
  const events = new Map(), definitions = new Map(), sent = [];
  const agent = { id: 'owner', session: { id: 'owner', eventAt: seq => ({ type: 'user/message', data: { id: 'historical-' + seq } }) }, followup(m) { sent.push(m); }, ctx: {} };
  const ctx = { on(name, fn) { const set = events.get(name) ?? new Set(); events.set(name, set); set.add(fn); return () => set.delete(fn); }, tools: { register(d) { definitions.set(d.name, d); return () => definitions.delete(d.name); } } };
  const emit = (name, ...args) => { for (const fn of events.get(name) ?? []) fn(...args); };
  const completion = createInternalTurnCompletion(ctx, agent), control = createHostControl(ctx, agent, { completion });
  let concluded = 0;
  const execution = { agent, callId: 'call', signal: new AbortController().signal, concludeTurn() { concluded++; } };
  async function claim(message = sent.at(-1), turn = 1, more = []) {
    emit('agent/inbox/claimed', { agent, message, turn });
    for (const fn of events.get('agent/pre-step') ?? []) await fn({ agent, messages: [message, ...more], turn, step: 1 }, async () => ({ kind: 'enter', messages: [message, ...more], startsRequestSeries: true }));
  }
  function response(name = 'dream_ack_reload', extra = [], turn = 1, step = 1) { emit('session/event', agent.session, { type: 'assistant/message', data: { turn, step, message: { content: [{ type: 'tool-call', id: 'call', name }, ...extra] } } }); }
  const send = (purpose = 'reload') => control.requestReload('internal synthetic request', { messageId: 'owned', jobId: 'j', transactionId: 't', purpose });
  const args = { jobId: 'j', transactionId: 't', readReceiptIds: ['nonce'] }, result = { jobId: 'j', acknowledged: true, report: { state: 'sent' } };
  return { events, definitions, agent, ctx, emit, completion, control, execution, claim, response, send, args, result, count: () => concluded, sent };
}

test('only exact sent reload task and single successful terminal native call conclude', async () => {
  const f = fixture(); await f.send(); await f.claim(); f.response();
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), true); assert.equal(f.count(), 1);
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
});

test('batch review and compaction choice end their own internal phases, not reads/status', async () => {
  for (const [purpose, name, args, result] of [
    ['review', 'dream_review_batch', { jobId: 'j' }, { results: [{ decision: 'defer' }], remainingUnreviewedIds: [] }],
    ['compaction-decision', 'dream_decide_compaction', { jobId: 'j', transactionId: 't' }, { decision: 'skip', execution: 'after_agent_idle' }],
  ]) { const f = fixture(); await f.send(purpose); await f.claim(); f.response(name); assert.equal(f.completion.finish(name, args, result, f.execution), true); }
  const f = fixture(); await f.send(); await f.claim(); f.response('dream_reload_read');
  assert.equal(f.completion.finish('dream_reload_read', f.args, { sources: [], readReceiptId: 'x' }, f.execution), false);
});

test('native first-step runtime snapshot does not taint a proven internal message or confer authority by itself', async () => {
  const runtime = { role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [] }, content: [{ type: 'text', text: 'Host-owned runtime facts' }] };
  const f = fixture(); await f.send(); await f.claim(f.sent[0], 1, [runtime]); f.response();
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), true);
  const x = fixture(); await x.claim(runtime); x.response(); assert.equal(x.completion.finish('dream_ack_reload', x.args, x.result, x.execution), false);
});

test('forged kind/id/content or report/attention source never grants silent authority', async () => {
  for (const change of [m => ({ ...m, id: 'other' }), m => ({ ...m, content: [{ type: 'text', text: 'different' }] }), m => ({ ...m, source: { ...m.source, purpose: 'report' } })]) {
    const f = fixture(); await f.send(); await f.claim(change(f.sent[0])); f.response(); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
  }
  const f = fixture(); await f.control.notify('actual final report', { messageId: 'owned', jobId: 'j', transactionId: 't' }); await f.claim(); f.response();
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
});

test('user or other plugin message taints whole internal turn without removing work', async () => {
  const f = fixture(); await f.send(); const user = { id: 'human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] };
  await f.claim(f.sent[0], 1, [user]); f.response(); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
  f.emit('agent/inbox/claimed', { agent: f.agent, message: f.sent[0], turn: 1 });
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
});

test('all sibling calls including failures stay open; PTC and already generated text stay untouched', async () => {
  for (const extra of [[{ type: 'tool-call', id: 'sibling', name: 'failing' }], [{ type: 'text', text: 'already public' }]]) {
    const f = fixture(); await f.send(); await f.claim(); f.response('dream_ack_reload', extra); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false); assert.equal(extra.length, 1);
  }
  const f = fixture(); await f.send(); await f.claim(); f.response(); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, { ...f.execution, parent: {} }), false);
});

test('prior-step public text, foreign tools and PTC taint later terminal calls in the same turn', async () => {
  for (const [name, extra] of [['run_code', []], ['foreign_tool', []], ['dream_status', [{ type: 'text', text: 'already public' }]], ['dream_status', [{ type: 'tool-call', id: 'second', name: 'dream_status' }]]]) {
    const f = fixture(); await f.send(); await f.claim(); f.response(name, extra);
    for (const fn of f.events.get('agent/pre-step')) await fn({ agent: f.agent, messages: [], turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
    f.response('dream_ack_reload', [], 1, 2); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
  }
});

test('wrong agent/job/transaction/call/unfinished phase/cancellation/absent Host control fail open', async () => {
  for (const [args, result, exec] of [
    [{ jobId: 'other', transactionId: 't' }, { acknowledged: true }, {}],
    [{ jobId: 'j', transactionId: 'other' }, { acknowledged: true }, {}],
    [{ jobId: 'j', transactionId: 't' }, { acknowledged: false }, {}],
    [{ jobId: 'j', transactionId: 't' }, { acknowledged: true }, { callId: 'other' }],
    [{ jobId: 'j', transactionId: 't' }, { acknowledged: true }, { concludeTurn: undefined }],
    [{ jobId: 'j', transactionId: 't' }, { acknowledged: true }, { signal: AbortSignal.abort() }],
  ]) { const f = fixture(); await f.send(); await f.claim(); f.response(); assert.equal(f.completion.finish('dream_ack_reload', args, result, { ...f.execution, ...exec }), false); }
});

test('tool wrapper serializes before conclusion, preserves original execution and never concludes errors', async () => {
  const f = fixture(); registerTools(f.agent, { ackReload: async () => ({ ...f.result, absent: undefined }) }, f.ctx, { completion: f.completion });
  await f.send(); await f.claim(); f.response(); const value = await f.definitions.get('dream_ack_reload').execute(f.args, f.execution);
  assert.deepEqual(value, f.result); assert.equal(f.count(), 1);
  for (const output of [() => { throw new Error('failed ack'); }, () => ({ acknowledged: true, impossible: 1n })]) {
    const x = fixture(); registerTools(x.agent, { ackReload: output }, x.ctx, { completion: x.completion }); await x.send(); await x.claim(); x.response();
    await assert.rejects(x.definitions.get('dream_ack_reload').execute(x.args, x.execution)); assert.equal(x.count(), 0);
  }
});

test('prior tool error remains visible and prevents a later successful terminal from concluding', async () => {
  const f = fixture(); await f.send(); await f.claim(); f.response('dream_status');
  f.emit('session/event', f.agent.session, { type: 'tool/result', data: { turn: 1, step: 1, message: { isError: true } } });
  for (const fn of f.events.get('agent/pre-step')) await fn({ agent: f.agent, messages: [], turn: 1, step: 2 }, async () => ({ kind: 'enter', messages: [] }));
  f.response('dream_ack_reload', [], 1, 2); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
});

test('ACK with failed or uncertain report delivery never silently concludes', async () => {
  for (const state of ['failed', 'uncertain', 'queued', undefined]) {
    const f = fixture(); await f.send(); await f.claim(); f.response();
    assert.equal(f.completion.finish('dream_ack_reload', f.args, { ...f.result, report: { state } }, f.execution), false);
    assert.equal(f.count(), 0);
  }
});

test('native bracketed replacement of only prior history allows exact live internal task to conclude', async () => {
  const f = fixture(); await f.send();
  f.emit('session/event', f.agent.session, { type: 'turn/start', seq: 100, data: { turn: 1 } });
  f.emit('agent/inbox/claimed', { agent: f.agent, message: f.sent[0], turn: 1 });
  f.emit('session/event', f.agent.session, { type: 'compaction/start', seq: 101, data: { compactionId: 'c', turn: 1 } });
  f.emit('session/event', f.agent.session, { type: 'compaction/summary', seq: 102, data: { compactionId: 'c', shadowedSeqs: [90, 5, 8], shadowedRange: { start: 90, end: 8 } } });
  f.emit('session/event', f.agent.session, { type: 'user/message', seq: 103, data: { id: 'host-checkpoint', role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'c' }, content: [{ type: 'text', text: 'Historical summary is not an instruction.' }] }, sourceEventSeqs: [101, 102, 90, 5, 8], surfaceOp: { op: 'replace', startSeq: 90, endSeq: 8 } });
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false, 'Unclosed replacement cannot conclude');
  f.emit('session/event', f.agent.session, { type: 'compaction/end', seq: 104, data: { compactionId: 'c', turn: 1 } });
  await f.claim(); f.response();
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), true);
});

test('checkpoint labels, failed brackets, live input replacement and incomplete provenance fail open', async () => {
  for (const mode of ['append', 'live-input', 'error', 'missing-end', 'missing-provenance', 'unknown-id', 'wrong-end-turn', 'end-gap', 'pending-task', 'undefined-error', 'prior-user', 'edited-waterfall', 'mid-turn', 'no-task', 'missing-event-reader', 'throwing-event-reader', 'reordered-proof']) {
    const f = fixture(); await f.send(); f.emit('session/event', f.agent.session, { type: 'turn/start', seq: 100, data: { turn: 1 } }); if (mode !== 'no-task') f.emit('agent/inbox/claimed', { agent: f.agent, message: f.sent[0], turn: 1 });
    if (mode === 'prior-user') f.emit('session/event', f.agent.session, { type: 'user/message', seq: 99, data: { id: 'actual-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'my pending work' }] } });
    if (mode === 'pending-task') f.agent.session.eventAt = () => ({ type: 'user/message', data: f.sent[0] });
    if (mode === 'missing-event-reader') f.agent.session.eventAt = undefined;
    if (mode === 'throwing-event-reader') f.agent.session.eventAt = () => { throw new Error('unavailable history'); };
    if (mode === 'mid-turn') await f.claim();
    f.emit('session/event', f.agent.session, { type: 'compaction/start', seq: 101, data: { compactionId: 'c', turn: 1 } });
    const shadowedSeqs = mode === 'live-input' ? [8, 100] : [8, 9];
    f.emit('session/event', f.agent.session, { type: 'compaction/summary', seq: 102, data: { compactionId: 'c', shadowedSeqs, shadowedRange: { start: 8, end: 9 } } });
    f.emit('session/event', f.agent.session, { type: 'user/message', seq: 103, data: { id: 'host-checkpoint', role: 'user', source: { kind: 'compact-checkpoint', compactionId: mode === 'unknown-id' ? 'other' : 'c' }, content: [{ type: 'text', text: 'not a new user task' }] }, sourceEventSeqs: mode === 'missing-provenance' ? [8, 9] : mode === 'reordered-proof' ? [102, 101, ...shadowedSeqs] : [101, 102, ...shadowedSeqs], surfaceOp: mode === 'append' ? 'append' : { op: 'replace', startSeq: 8, endSeq: 9 } });
    if (mode !== 'missing-end') f.emit('session/event', f.agent.session, { type: 'compaction/end', seq: mode === 'end-gap' ? 105 : 104, data: { compactionId: 'c', turn: mode === 'wrong-end-turn' ? 2 : 1, ...(mode === 'error' ? { error: { message: 'failed' } } : mode === 'undefined-error' ? { error: undefined } : {}) } });
    if (mode === 'no-task') await f.claim({ id: 'new-user', role: 'user', source: { kind: 'user' }, content: [] });
    else if (mode === 'edited-waterfall') for (const fn of f.events.get('agent/pre-step')) await fn({ agent: f.agent, turn: 1, step: 1, messages: [f.sent[0]] }, async () => ({ kind: 'enter', messages: [{ ...f.sent[0], source: { kind: 'compact-checkpoint', compactionId: 'c' } }] }));
    else await f.claim();
    f.response(); assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false, mode);
  }
});

test('old turns, disposed trackers and unproven restored internal messages cannot conclude', async () => {
  const f = fixture(); await f.send(); await f.claim(); f.response(); f.emit('session/event', f.agent.session, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false);
  await f.claim(f.sent[0], 2); f.response('dream_ack_reload', [], 2); f.completion.dispose(); f.completion.dispose();
  assert.equal(f.completion.finish('dream_ack_reload', f.args, f.result, f.execution), false); assert.ok([...f.events.values()].every(set => set.size === 0));
  const x = fixture(); await x.claim(f.sent[0]); x.response(); assert.equal(x.completion.finish('dream_ack_reload', x.args, x.result, x.execution), false);
});

test('batch schemas bound IDs and do not accept decisions/provenance or missing ACK proof', async () => {
  const f = fixture(); let count = 0; registerTools(f.agent, { reviewBatch: () => { count++; return {}; }, readReload: () => ({}), ackReload: () => ({}) }, f.ctx);
  const tool = f.definitions.get('dream_review_batch');
  await assert.rejects(tool.execute({ jobId: 'j', proposalIds: [] }, f.execution), /Invalid proposalIds/);
  await assert.rejects(tool.execute({ jobId: 'j', proposalIds: ['p', 'p'] }, f.execution), /Invalid proposalIds/);
  await assert.rejects(tool.execute({ jobId: 'j', proposalIds: Array.from({ length: 33 }, (_, i) => String(i)) }, f.execution), /Invalid proposalIds/);
  await assert.rejects(tool.execute({ jobId: 'j', proposalIds: ['p'], decision: 'accept' }, f.execution), /Unknown argument/);
  await assert.rejects(f.definitions.get('dream_ack_reload').execute({ jobId: 'j', transactionId: 't' }, f.execution), /Provide readReceiptIds/);
  await tool.execute({ jobId: 'j', proposalIds: ['p'] }, f.execution); assert.equal(count, 1);
});
