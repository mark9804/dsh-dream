import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeRecallSchema, readToolResponse, runAutonomousRecall, RECALL_GUIDANCE, AUTONOMOUS_LIMITS } from '../scripts/lib/autonomous-recall.js';
import { registerTools } from '../dist/harness/tools.js';
import { readFile } from 'node:fs/promises';

const controls = { provider: 'synthetic', model: 'native' };
const response = (...content) => [...content.map((block, index) => ({ type: 'block-end', index, block })), { type: 'finish', reason: { kind: content.some(b => b.type === 'tool-call') ? 'tool-calls' : 'stop' } }];
const stream = values => (async function* () { yield* values; })();
const schema = freezeRecallSchema(registerTools);

test('schema and strategies remain distinct, query-free and unchanged across two prompt arms', async () => {
  assert.equal(schema.name, 'dream_recall'); assert.deepEqual(schema.parameters.required, ['query', 'topic', 'conditions']);
  assert.equal(schema.description.includes(RECALL_GUIDANCE), false);
  const fixture = JSON.parse(await readFile(new URL('./fixtures/autonomous-recall.json', import.meta.url), 'utf8'));
  assert.equal(fixture.cases.length, 12); assert.equal(fixture.cases.filter(c => !c.shouldRecall).length, 3);
  for (const c of fixture.cases) { assert.equal(c.question.includes('dream_recall'), false); assert.equal('query' in c, false); }
  assert.equal(RECALL_GUIDANCE.includes('蓝信封'), false); assert.equal(RECALL_GUIDANCE.includes('林岚'), false);
});

test('native stream parses deltas/final blocks without duplicating or retaining reasoning', async () => {
  const actual = await readToolResponse(stream([
    { type: 'reasoning-delta', index: 0, text: 'private not stored' },
    { type: 'tool-call-delta', index: 1, id: 'a', name: 'dream_recall', argumentsDelta: '{"query":' },
    { type: 'tool-call-delta', index: 1, id: 'a', argumentsDelta: '"杯子"}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'a', name: 'dream_recall', arguments: '{"query":"杯子"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]));
  assert.equal(actual.calls.length, 1); assert.equal(actual.calls[0].arguments, '{"query":"杯子"}'); assert.equal(JSON.stringify(actual).includes('private'), false);
});

test('cold driver lets the model choose when and how to call and keeps tool/result identity within one episode', async () => {
  const requests = [], events = []; let calls = 0, next = 0;
  const llm = { async prepareCall(config) { assert.deepEqual(config, controls); return { config, async *stream(request) {
    requests.push(request); yield* calls++ === 0 ? response({ type: 'tool-call', id: 'call-1', name: 'dream_recall', arguments: '{"query":"蓝信封","topic":"物件","conditions":"合成历史"}' }) : response({ type: 'text', text: '找到了。' });
  } }; } };
  const result = await runAutonomousRecall({ llm, controls, schema, system: 'neutral', question: '杯子哪来的？', id: () => `uuid-${++next}`, execute: async args => { assert.equal(args.query, '蓝信封'); return { hits: [{ text: 'synthetic current quote' }] }; }, record: async (...e) => events.push(e) });
  assert.equal(result.state, 'completed'); assert.equal(result.toolCount, 1); assert.equal(result.answer, '找到了。');
  assert.equal(requests[0].messages.length, 1); assert.equal(requests[0].messages[0].content[0].text, '杯子哪来的？');
  assert.equal(requests[1].sessionId, requests[0].sessionId); assert.equal(requests[1].messages[2].role, 'tool');
  assert.equal(requests[1].messages[2].toolCallId, 'call-1'); assert.equal(requests[1].messages[2].source.callId, 'call-1');
  assert.equal(requests.some(r => 'toolHistory' in r || 'replayState' in r), false); assert.equal(events.filter(e => e[0] === 'tool').length, 1);
});

test('self-contained answer needs no tool and a new episode never inherits previous messages', async () => {
  const llm = { async prepareCall(config) { return { config, async *stream(req) { assert.equal(req.messages.length, 1); yield* response({ type: 'text', text: '391' }); } }; } };
  const input = { llm, controls, schema, system: 'neutral', question: '23×17?', execute: () => assert.fail('No forced recall'), record: async () => {} };
  const a = await runAutonomousRecall(input), b = await runAutonomousRecall(input); assert.equal(a.toolCount, 0); assert.notEqual(a.sessionId, b.sessionId);
});

test('tool failures remain explicit and do not become fabricated empty hits; unlisted tools never execute', async () => {
  let calls = 0, executed = 0; const requests = [];
  const llm = { async prepareCall(config) { return { config, async *stream(req) { requests.push(req); yield* calls++ === 0 ? response({ type: 'tool-call', id: 'x', name: 'write_memory', arguments: '{}' }) : response({ type: 'text', text: '无法读取。' }); } }; } };
  await runAutonomousRecall({ llm, controls, schema, system: 'x', question: 'q', execute: () => executed++, record: async () => {} });
  assert.equal(executed, 0); assert.equal(requests[1].messages[2].isError, true); assert.match(requests[1].messages[2].content[0].text, /Only the presented/);
});

test('bounded steps/tools, failed finish and abort never masquerade as completed recall', async () => {
  let executes = 0; const llm = { async prepareCall(config) { return { config, async *stream() { yield* response({ type: 'tool-call', id: 'x', name: 'dream_recall', arguments: '{}' }); } }; } };
  const input = { llm, controls, schema, system: 'x', question: 'q', execute: async () => { executes++; return { hits: [] }; }, record: async () => {}, limits: { ...AUTONOMOUS_LIMITS, maxSteps: 2, maxTools: 1 } };
  const r = await runAutonomousRecall(input); assert.equal(r.state, 'budget-exhausted'); assert.equal(executes, 1);
  await assert.rejects(readToolResponse(stream([{ type: 'finish', reason: { kind: 'max-tokens' } }])), /Unsuccessful/);
  await assert.rejects(runAutonomousRecall({ ...input, signal: AbortSignal.abort(new Error('stop')) }), /stop/);
});
