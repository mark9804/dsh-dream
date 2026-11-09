import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_FIELDS, configurationDefaults, validateConfig, validateDreamModelChoice } from '../dist/config.js';
import { captureModelCall, captureModelChoice } from '../dist/harness/model-selection.js';
import { createHostModel } from '../dist/harness/model.js';
import { createCleanReviewer } from '../dist/harness/clean-review.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { createFreeDreamWriter } from '../dist/dream/free-executor.js';

const base = { sessionId: 'synthetic-parent', memoryRoot: '/synthetic/model-memory', stateRoot: '/synthetic/model-state' };
const parent = { provider: 'parent-provider', model: 'parent-model', reasoningEffort: 'high', maxTokens: 900, temperature: 0, stop: ['PARENT_END'] };
const custom = { provider: 'custom-provider', model: 'custom-model' };
const stop = { type: 'finish', reason: { kind: 'stop' } };
const verdict = JSON.stringify({ decision: 'defer', reason: 'Synthetic independent review.' });
function agent() {
  return { id: base.sessionId, session: { id: base.sessionId, requestHeader: () => ({ config: parent }) },
    options: { maxTokens: 123 }, model: { current: () => ({ provider: parent.provider, model: parent.model, reasoningEffort: parent.reasoningEffort }) } };
}
function inaccessibleAgent() {
  const target = { id: base.sessionId };
  for (const key of ['model', 'session', 'options', 'history']) Object.defineProperty(target, key, { get() { assert.fail(`custom route must not inspect parent ${key}`); } });
  return target;
}
function context(answer = 'Synthetic output.', prepare = config => config) {
  const configs = [], inputs = [];
  return { configs, inputs, llm: { async prepareCall(config, signal) {
    configs.push(structuredClone(config));
    const actual = await prepare(config, signal);
    return { config: actual, async *stream(input) {
      inputs.push(input);
      const text = typeof answer === 'function' ? answer(input.messages[0].content[0].text) : answer;
      yield { type: 'text-delta', index: 0, text };
      yield stop;
    } };
  } } };
}
function reviewFixture() {
  const snapshot = { schemaVersion: 1, snapshotId: 'synthetic-snapshot', capturedAt: '2026-11-09T00:00:00Z',
    scope: { scopeId: 'scope', sessionId: base.sessionId, agentId: base.sessionId, memoryRootId: base.memoryRoot },
    sources: [{ sourceId: 'journal', path: 'journal.md', role: 'journal', content: 'Synthetic event.', version: 1, writable: false, sensitivity: 'private', protectedText: [] }] };
  const proposal = { schemaVersion: 1, jobId: 'job', proposalId: 'proposal', kind: 'fact', text: 'Synthetic event.', reason: 'Synthetic evidence.',
    targetId: 'journal', operation: 'retain', before: 'Synthetic event.', after: 'Synthetic event.', evidence: [{ sourceId: 'journal', quote: 'Synthetic event.' }] };
  return { snapshot, proposal };
}

// Offline synthetic fixtures only; no Host, real model, profile, or user memory.
test('old configuration gains no mandatory model fields or implicit branch overrides', () => {
  const defaults = configurationDefaults(); const config = validateConfig(base);
  for (const key of ['memoryModel', 'dreamModel', 'reviewModel']) {
    assert.equal(Object.hasOwn(defaults, key), false);
    assert.equal(Object.hasOwn(config, key), false);
    assert.ok(CONFIG_FIELDS.includes(key));
  }
  assert.deepEqual(validateDreamModelChoice({}), {});
  assert.equal(validateDreamModelChoice(undefined), undefined);
  const choices = { memoryModel: { ...custom }, dreamModel: { reasoningEffort: 'low' }, reviewModel: {} };
  const validated = validateConfig({ ...base, ...choices });
  for (const key of Object.keys(choices)) { assert.deepEqual(validated[key], choices[key]); assert.notEqual(validated[key], choices[key]); }
  choices.memoryModel.model = 'mutated';
  assert.equal(validated.memoryModel.model, custom.model);
});

test('model choices reject partial routes, unknown keys, invalid strings and non-plain objects', () => {
  const accessor = {}; Object.defineProperty(accessor, 'provider', { get() { assert.fail('must not run model choice getter'); } });
  for (const invalid of [null, [], 'model', new Date(), Object.create({ provider: 'p', model: 'm' }), accessor,
    { provider: 'p' }, { model: 'm' }, { provider: '', model: 'm' }, { provider: 'p', model: 'm m' },
    { provider: ' p', model: 'm' }, { provider: 'p', model: 'm\n' }, { provider: 'p', model: 'm\0' },
    { provider: 'p', model: 'm', tools: [] }, { reasoningEffort: '' }, { reasoningEffort: null },
    { reasoningEffort: ' low' }, { reasoningEffort: 1 }, { model: 'm', provider: 'x'.repeat(513) },
    { provider: 'p', model: 'x'.repeat(513) }, { reasoningEffort: 'x'.repeat(129) }, { [Symbol('unknown')]: 1 }]) {
    assert.throws(() => validateDreamModelChoice(invalid));
    for (const key of ['memoryModel', 'dreamModel', 'reviewModel']) assert.throws(() => validateConfig({ ...base, [key]: invalid }));
  }
  assert.deepEqual(validateDreamModelChoice({ provider: 'x'.repeat(512), model: 'x'.repeat(512), reasoningEffort: 'x'.repeat(128) }),
    { provider: 'x'.repeat(512), model: 'x'.repeat(512), reasoningEffort: 'x'.repeat(128) });
});

test('undefined and empty choices preserve exact prior follow selection and controls', async () => {
  const target = agent(); const expected = captureModelCall(target);
  for (const modelChoice of [undefined, {}]) {
    assert.deepEqual(captureModelChoice(target, modelChoice), expected);
    const ctx = context();
    await createHostModel(ctx, target, { modelChoice })('Synthetic input.');
    assert.deepEqual(ctx.configs, [expected]);
  }
});

test('effort-only choice overrides the followed route and retains its explicit controls', async () => {
  const target = agent(); const ctx = context();
  const expected = { ...captureModelCall(target), reasoningEffort: 'low' };
  await createHostModel(ctx, target, { modelChoice: { reasoningEffort: 'low' } })('Synthetic input.');
  assert.deepEqual(ctx.configs, [expected]);
  assert.equal(parent.reasoningEffort, 'high');
  assert.notEqual(ctx.inputs[0].stop, parent.stop);
});

test('custom routes never inspect parent state or carry its controls, including an equal route', async () => {
  for (const modelChoice of [custom, { provider: parent.provider, model: parent.model }, { ...custom, reasoningEffort: 'low' }]) {
    const ctx = context();
    await createHostModel(ctx, inaccessibleAgent(), { modelChoice })('Synthetic input.');
    assert.deepEqual(ctx.configs, [modelChoice]);
    for (const key of ['maxTokens', 'temperature', 'stop']) assert.equal(Object.hasOwn(ctx.inputs[0], key), false);
  }
});

test('custom omitted effort uses fresh adapter defaults, filters extra state and keeps isolated call IDs', async () => {
  let calls = 0;
  const ctx = context('Synthetic output.', config => ({ ...config, reasoningEffort: `default-${++calls}`, maxTokens: 456,
    system: 'MALICIOUS_SYSTEM', tools: ['MALICIOUS_TOOLS'], replayState: 'MALICIOUS_REPLAY', sessionId: base.sessionId }));
  const generate = createHostModel(ctx, agent(), { modelChoice: custom }).capture();
  await generate('Synthetic first.'); await generate('Synthetic second.');
  assert.deepEqual(ctx.configs, [custom, custom]);
  assert.deepEqual(ctx.inputs.map(input => input.reasoningEffort), ['default-1', 'default-2']);
  assert.equal(new Set(ctx.inputs.map(input => input.sessionId)).size, 2);
  for (const input of ctx.inputs) {
    assert.notEqual(input.sessionId, base.sessionId);
    assert.equal(input.maxTokens, 456);
    for (const key of ['system', 'tools', 'toolHistory', 'replayState']) assert.equal(Object.hasOwn(input, key), false);
  }
});

test('branch choices detach at construction and each admission freezes followed route across all stages', async () => {
  const choice = { reasoningEffort: 'low' }; const target = agent(); const ctx = context();
  const model = createHostModel(ctx, target, { modelChoice: choice });
  choice.reasoningEffort = 'high';
  const captured = model.capture();
  target.model.current = () => custom;
  await captured('Stage one.'); await captured('Stage two.'); await model('Next job.');
  assert.deepEqual(ctx.configs.slice(0, 2), [0, 1].map(() => ({ ...parent, maxTokens: 123, reasoningEffort: 'low' })));
  assert.deepEqual(ctx.configs[2], { ...custom, maxTokens: 123, reasoningEffort: 'low' });
});

test('unsupported effort rejects at actual preparation without clamping, fallback or cached capability', async () => {
  let supported = true;
  const failure = Object.assign(new Error('Unsupported exact effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
  const choice = { ...custom, reasoningEffort: 'precise-effort' };
  const ctx = context('Synthetic output.', config => { if (!supported) throw failure; return config; });
  const generate = createHostModel(ctx, agent(), { modelChoice: choice }).capture();
  assert.equal(ctx.configs.length, 0, 'capture must not pre-resolve a prepared call');
  await generate('First supported stage.'); supported = false;
  await assert.rejects(generate('Unsupported next stage.'), error => error === failure);
  assert.deepEqual(ctx.configs, [choice, choice]); assert.equal(ctx.inputs.length, 1);
});

test('custom review bypasses absent main route/step but preserves exact payload and actual route authority', async () => {
  const { snapshot, proposal } = reviewFixture();
  const ctx = context(verdict, config => ({ ...config, provider: 'actual-review', model: 'actual-model', reasoningEffort: 'default-effort' }));
  const review = createCleanReviewer(ctx, inaccessibleAgent(), { modelChoice: custom, modelSelection() { assert.fail('custom review must not require a main step'); } });
  const result = await review(snapshot, proposal);
  assert.equal(result.decision, 'defer'); assert.deepEqual(ctx.configs, [custom]);
  assert.equal(result.authority.provider, 'actual-review'); assert.equal(result.authority.model, 'actual-model');
  assert.equal(result.authority.callId, ctx.inputs[0].sessionId);
  assert.match(ctx.inputs[0].messages[0].content[0].text, /Synthetic event/);
  assert.equal(ctx.inputs[0].messages.length, 1); assert.equal(Object.hasOwn(ctx.inputs[0], 'system'), false);
});

test('follow review and effort-only review still require an active captured step when configured', async () => {
  const { snapshot, proposal } = reviewFixture(); const target = agent();
  for (const modelChoice of [undefined, {}, { reasoningEffort: 'low' }]) {
    const ctx = context(verdict);
    await assert.rejects(createCleanReviewer(ctx, target, { modelChoice, modelSelection: () => undefined })(snapshot, proposal), /active-step/);
    assert.equal(ctx.configs.length, 0);
  }
  const ctx = context(verdict);
  const step = { provider: 'step-provider', model: 'step-model', reasoningEffort: 'high' };
  await createCleanReviewer(ctx, target, { modelChoice: { reasoningEffort: 'low' }, modelSelection: () => step })(snapshot, proposal);
  assert.deepEqual(ctx.configs, [{ ...step, reasoningEffort: 'low', maxTokens: 123 }]);
});

test('custom review unsupported effort produces neither stream nor acceptance and never retries a parent route', async () => {
  const { snapshot, proposal } = reviewFixture(); const failure = new Error('Synthetic capability rejected');
  const ctx = context(verdict, () => { throw failure; }); const choice = { ...custom, reasoningEffort: 'unsupported' };
  await assert.rejects(createCleanReviewer(ctx, inaccessibleAgent(), { modelChoice: choice })(snapshot, proposal), error => error === failure);
  assert.deepEqual(ctx.configs, [choice]); assert.equal(ctx.inputs.length, 0);
});

test('custom model preparation cancellation still prevents dispatch and drains a pending preparation', async () => {
  const controller = new AbortController(); let release, settled = false;
  const ctx = context('Synthetic output.', config => new Promise(resolve => { release = () => resolve(config); }));
  const pending = createHostModel(ctx, inaccessibleAgent(), { modelChoice: custom })('Synthetic input.', { signal: controller.signal });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, /cancel custom/);
  controller.abort(new Error('cancel custom')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); release(); await rejected; assert.equal(ctx.inputs.length, 0);
});

test('independent memory and dream workers plus reviewer dispatch only their configured branch routes', async () => {
  const { snapshot, proposal } = reviewFixture(); const target = inaccessibleAgent();
  const choices = { memoryModel: { provider: 'memory-provider', model: 'memory-model', reasoningEffort: 'low' },
    dreamModel: { provider: 'dream-provider', model: 'dream-model' }, reviewModel: { provider: 'review-provider', model: 'review-model', reasoningEffort: 'high' } };
  const ctx = context(prompt => {
    if (prompt.startsWith('ORGANIZE：')) return JSON.stringify({ coveredSourceIds: ['journal'], episodes: [] });
    if (prompt.includes('\nDEEP：')) return JSON.stringify({ proposals: [] });
    if (prompt.includes('UNTRUSTED_DREAM_INPUT_JSON')) return JSON.stringify({ dream: 'Synthetic blue river.', afterFeeling: '' });
    return verdict;
  });
  const memoryModel = createHostModel(ctx, target, { modelChoice: choices.memoryModel });
  const dreamModel = createHostModel(ctx, target, { modelChoice: choices.dreamModel });
  const result = await createWorkerGenerator(memoryModel, { timeoutMs: 5000, maxOutputBytes: 4096, maxProposals: 2, maxEpisodes: 2 }, 'memory-v2')(snapshot, 'job');
  await createFreeDreamWriter(dreamModel, { timeoutMs: 5000, maxOutputBytes: 4096 })({ schemaVersion: 1, jobId: 'job', snapshotId: snapshot.snapshotId,
    episodes: result.digest, conversation: { messages: [], coverage: { requested: 0, included: 0, omitted: 0, unavailable: 0, reasons: [] } } });
  await createCleanReviewer(ctx, target, { modelChoice: choices.reviewModel, modelSelection: () => undefined })(snapshot, proposal);
  assert.deepEqual(ctx.configs, [choices.memoryModel, choices.memoryModel, choices.dreamModel, choices.reviewModel]);
  assert.equal(new Set(ctx.inputs.map(input => input.sessionId)).size, 4);
  assert.deepEqual(result.proposals, []);
});
