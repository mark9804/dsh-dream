import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostModel } from '../dist/harness/model.js';

const stop = { type: 'finish', reason: { kind: 'stop' } };
const text = { type: 'text-delta', index: 0, text: 'Synthetic dream output.' };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const tick = () => new Promise(resolve => setImmediate(resolve));
const makeAgent = (config = { provider: 'selected', model: 'selected-model' }) => ({
  id: 'parent-session', session: { id: 'parent-session', requestHeader: () => ({ config }) },
  options: { provider: 'old', model: 'old-model' },
});
function context(chunks = [text, stop], seen = {}, prepare = config => config) {
  return { llm: { async prepareCall(config, signal) {
    seen.config = config;
    seen.signal = signal;
    seen.prepareCount = (seen.prepareCount ?? 0) + 1;
    return { config: prepare(config), async *stream(input) {
      (seen.inputs ??= []).push(input);
      yield* chunks;
    } };
  } } };
}
const generate = (chunks, options) => createHostModel(context(chunks), makeAgent(), options)('Synthetic input.');

// In-memory mocks only: no Host/model calls, sessions, native state, or memory files.
test('each generation uses a new adapter conversation and exactly its own supplied prompt', async () => {
  const seen = {};
  const target = makeAgent();
  target.history = [{ role: 'assistant', content: 'PARENT_HISTORY_SENTINEL' }];
  target.session.messages = [{ role: 'system', content: 'PARENT_SYSTEM_SENTINEL' }];
  target.session.replayState = { response: 'PARENT_REPLAY_SENTINEL' };
  const model = createHostModel(context([text, stop], seen), target);
  const prompts = ['Synthetic first-stage input.', 'Synthetic next-stage input.'];
  assert.deepEqual(await Promise.all(prompts.map(prompt => model(prompt))), [text.text, text.text]);
  assert.equal(seen.prepareCount, 2);
  assert.equal(seen.inputs.length, 2);
  assert.notEqual(seen.inputs[0].sessionId, seen.inputs[1].sessionId);
  for (let i = 0; i < seen.inputs.length; i++) {
    const input = seen.inputs[i];
    assert.match(input.sessionId, uuid);
    assert.notEqual(input.sessionId, 'parent-session');
    assert.equal(input.provider, 'selected');
    assert.equal(input.model, 'selected-model');
    assert.deepEqual(input.messages, [{ role: 'user', content: [{ type: 'text', text: prompts[i] }] }]);
    assert.doesNotMatch(JSON.stringify(input), /SENTINEL/);
  }
});

test('selected and prepared configs cannot inject native state, system input, tools, or history', async () => {
  const extras = {
    system: 'SYSTEM_SENTINEL', messages: [{ role: 'system', content: 'MESSAGES_SENTINEL' }],
    tools: ['TOOLS_SENTINEL'], toolHistory: 'TOOL_HISTORY_SENTINEL', history: ['HISTORY_SENTINEL'],
    replayState: { response: 'REPLAY_SENTINEL' }, nativeState: 'NATIVE_SENTINEL',
    sessionId: 'PARENT_SESSION_SENTINEL', purpose: 'compaction', source: { kind: 'system-prompt' },
  };
  const target = makeAgent({ provider: 'selected', model: 'selected-model', ...extras });
  const prepared = { provider: 'actual', model: 'actual-model', ...extras };
  const seen = {};
  const signal = new AbortController().signal;
  await createHostModel(context([text, stop], seen, () => prepared), target)('Only this synthetic input.', { signal });
  assert.deepEqual(seen.config, { provider: 'selected', model: 'selected-model' });
  const [input] = seen.inputs;
  assert.deepEqual(Object.keys(input).sort(), ['messages', 'model', 'provider', 'sessionId', 'signal']);
  assert.equal(input.provider, 'actual');
  assert.equal(input.model, 'actual-model');
  assert.equal(input.signal, signal);
  assert.equal(seen.signal, signal);
  assert.deepEqual(input.messages, [{ role: 'user', content: [{ type: 'text', text: 'Only this synthetic input.' }] }]);
  assert.equal(Object.hasOwn(input.messages[0], 'source'), false, 'native RequestUserInput has no system-prompt source');
  assert.equal(Object.hasOwn(input, 'system'), false, 'native routes get no inherited system input');
  assert.doesNotMatch(JSON.stringify(input), /SENTINEL/);
});

test('generation never reads parent native state or unknown config properties', async () => {
  const selected = { provider: 'native-route', model: 'same-model' };
  const prepared = { ...selected };
  const target = makeAgent(selected);
  for (const value of [target, target.session, selected, prepared]) {
    for (const key of ['history', 'messages', 'system', 'tools', 'toolHistory', 'replayState', 'nativeState', 'source']) {
      Object.defineProperty(value, key, { enumerable: true, get() { assert.fail(`must not read inherited ${key}`); } });
    }
  }
  Object.defineProperty(target.session, 'id', { get() { assert.fail('must not reuse the native parent session'); } });
  assert.equal(await createHostModel(context([text, stop], {}, () => prepared), target)('Synthetic input.'), text.text);
});

test('four supported controls stay detached across selected and prepared boundaries', async () => {
  for (const useHeader of [true, false]) {
    const selected = { provider: 'selected', model: 'selected-model', maxTokens: 123,
      reasoningEffort: 'low', temperature: 0, stop: ['END'] };
    const actual = { provider: 'actual', model: 'actual-model', maxTokens: 456,
      reasoningEffort: 'resolved', temperature: 0.25, stop: ['DONE'] };
    const target = makeAgent(selected);
    if (!useHeader) { delete target.session.requestHeader; target.options = selected; }
    const seen = {};
    await createHostModel(context([text, stop], seen, () => actual), target)('Synthetic input.');
    assert.deepEqual(seen.config, selected);
    assert.notEqual(seen.config.stop, selected.stop);
    const [input] = seen.inputs;
    for (const key of Object.keys(actual)) assert.deepEqual(input[key], actual[key]);
    assert.notEqual(input.stop, actual.stop);
    assert.deepEqual(Object.keys(input).sort(), [...Object.keys(actual), 'messages', 'sessionId', 'signal'].sort());
    input.stop.push('STREAM_MUTATION');
    seen.config.stop.push('PREPARE_MUTATION');
    assert.deepEqual(selected.stop, ['END']);
    assert.deepEqual(actual.stop, ['DONE']);
  }
});

test('missing, blank, or nonstring selected and actual routes reject before dispatch', async () => {
  const invalid = [undefined, null, {}, { provider: 'p' }, { model: 'm' },
    { provider: '', model: 'm' }, { provider: ' \t', model: 'm' },
    { provider: 'p', model: '' }, { provider: 'p', model: '\n' },
    { provider: 1, model: 'm' }, { provider: 'p', model: {} }];
  for (const config of invalid) {
    const target = makeAgent();
    target.session.requestHeader = () => ({ config });
    target.options = config;
    const selectedSeen = {};
    await assert.rejects(createHostModel(context([text, stop], selectedSeen), target)('Synthetic input.'), /provider\/model/);
    assert.equal(selectedSeen.prepareCount, undefined);
    const actualSeen = {};
    await assert.rejects(createHostModel(context([text, stop], actualSeen, () => config), makeAgent())('Synthetic input.'), /provider\/model/);
    assert.equal(actualSeen.prepareCount, 1);
    assert.equal(actualSeen.inputs, undefined);
  }
});

test('stream assembly excludes reasoning and accepts matching final blocks only once', async () => {
  assert.equal(await generate([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Private synthetic reasoning, not output.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Private final reasoning.' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'world' },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'world' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello ' } },
    stop, { type: 'usage', usage: {} },
  ]), 'hello world');
});

test('malformed streams, tools and conflicting output fail closed', async () => {
  for (const chunks of [
    [null], [[]], [{ type: 'unknown' }, text, stop], [text], [stop], [text, stop, stop],
    [text, { type: 'finish' }], [text, { type: 'finish', reason: { kind: 1 } }],
    ...['max-tokens', 'error', 'aborted', 'tool-calls', 'unknown'].map(kind => [text, { type: 'finish', reason: { kind } }]),
    [{ type: 'tool-call-delta' }, text, stop],
    ...['tool-call', 'tool-addition', 'tool-removal'].flatMap(kind => [
      [{ type: 'block-start', index: 0, blockType: kind }, text, stop],
      [{ type: 'block-end', index: 0, block: { type: kind } }, text, stop],
    ]),
    ...['image', 'file'].map(kind => [{ type: 'block-end', index: 0, block: { type: kind } }, text, stop]),
    ...[-1, 0.5, NaN, Infinity, '0'].map(index => [{ ...text, index }, stop]),
    [{ ...text, text: 1 }, stop], [{ type: 'block-end', index: 0, block: { type: 'text' } }, stop],
    [{ type: 'block-end', index: 0, block: null }, stop],
    [text, { type: 'block-end', index: 0, block: { type: 'text', text: 'Conflicting final output.' } }, stop],
    [text, { type: 'block-start', index: 0, blockType: 'text' }, stop],
    [text, { type: 'reasoning-delta', index: 0, text: 'Conflicting type.' }, stop],
    [text, { type: 'block-end', index: 0, block: { type: 'text', text: text.text } }, text, stop],
    [text, stop, text], [text, stop, { type: 'reasoning-delta', index: 1, text: 'Late reasoning.' }],
  ]) await assert.rejects(generate(chunks));
});

test('UTF-8 and block count limits remain bounded without resetting model controls', async () => {
  assert.throws(() => createHostModel({}, makeAgent()), /unavailable/);
  for (const maxOutputBytes of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => createHostModel(context(), makeAgent(), { maxOutputBytes }), /maxOutputBytes/);
  }
  for (const prompt of ['', ' \n', null, 1]) {
    await assert.rejects(createHostModel(context(), makeAgent())(prompt), /nonempty text/);
  }
  const output = '合成';
  const chunks = [{ type: 'block-end', index: 0, block: { type: 'text', text: output } }, stop];
  await assert.rejects(generate(chunks, { maxOutputBytes: output.length }), /byte limit/);
  assert.equal(await generate(chunks, { maxOutputBytes: Buffer.byteLength(output) }), output);
  await assert.rejects(generate([
    { type: 'text-delta', index: 0, text: '123' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '456' } }, stop,
  ], { maxOutputBytes: 5 }), /byte limit/);
  const empty = Array.from({ length: 1025 }, (_value, index) => ({ type: 'block-start', index, blockType: 'text' }));
  await assert.rejects(generate(empty), /too many blocks/);
});

test('cancellation still waits for preparation to drain and prevents late dispatch', async () => {
  const controller = new AbortController();
  let release;
  let settled = false;
  const ctx = { llm: { prepareCall(config, signal) {
    assert.equal(signal, controller.signal);
    return new Promise(resolve => { release = () => resolve({ config, stream() { assert.fail('cancelled preparation must never dispatch'); } }); });
  } } };
  const pending = createHostModel(ctx, makeAgent())('Synthetic input.', { signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, /cancel preparation/);
  controller.abort(new Error('cancel preparation'));
  await tick();
  assert.equal(settled, false, 'must not bypass underlying preparation with a cancellation race');
  release();
  await rejected;
});

test('cancellation still waits for pending next and iterator cleanup before releasing generation', async () => {
  const controller = new AbortController();
  let releaseNext;
  let releaseReturn;
  let started;
  let cleaning;
  let settled = false;
  const ready = new Promise(resolve => { started = resolve; });
  const cleanup = new Promise(resolve => { cleaning = resolve; });
  const ctx = { llm: { async prepareCall(config) {
    return { config, stream(input) {
      assert.equal(input.signal, controller.signal);
      return { [Symbol.asyncIterator]() { return {
        next() { started(); return new Promise(resolve => { releaseNext = resolve; }); },
        return() { cleaning(); return new Promise(resolve => { releaseReturn = resolve; }); },
      }; } };
    } };
  } } };
  const pending = createHostModel(ctx, makeAgent())('Synthetic input.', { signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, /cancel stream/);
  await ready;
  controller.abort(new Error('cancel stream'));
  await tick();
  assert.equal(settled, false, 'pending provider iteration must drain');
  releaseNext({ value: text, done: false });
  await cleanup;
  await tick();
  assert.equal(settled, false, 'iterator return must drain too');
  releaseReturn({ done: true });
  await rejected;
});

test('abort after stop but before stream completion cannot return output', async () => {
  const controller = new AbortController();
  const ctx = { llm: { async prepareCall(config) {
    return { config, async *stream() {
      yield text;
      yield stop;
      controller.abort(new Error('cancel after stop'));
    } };
  } } };
  await assert.rejects(createHostModel(ctx, makeAgent())('Synthetic input.', { signal: controller.signal }), /cancel after stop/);
});
