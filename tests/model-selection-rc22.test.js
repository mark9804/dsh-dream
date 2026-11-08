import assert from 'node:assert/strict';
import test from 'node:test';
import { captureModelCall, copyCallConfig, createModelSelectionTracker } from '../dist/harness/model-selection.js';
import { createHostModel } from '../dist/harness/model.js';
import { createCleanReviewer } from '../dist/harness/clean-review.js';

const old = { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high', maxTokens: 2048, temperature: 0.8, stop: ['OLD'] };
const selected = { provider: 'selected-provider', model: 'selected-model' };
function agent(selection = selected) {
  return { id: 'synthetic-agent', session: { id: 'synthetic-agent', requestHeader: () => ({ config: structuredClone(old) }) },
    options: { provider: 'initial-provider', model: 'initial-model' }, model: { current: () => selection } };
}
function context(text = 'Synthetic generated output.', prepare = config => config) {
  const configs = [], inputs = [];
  return { configs, inputs, llm: { async prepareCall(config, signal) {
    configs.push(structuredClone(config));
    const actual = await prepare(config, signal);
    return { config: actual, async *stream(input) {
      inputs.push(input);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } } };
}
function events() {
  const listeners = new Map();
  return {
    on(event, callback) {
      const set = listeners.get(event) ?? new Set(); set.add(callback); listeners.set(event, set);
      return () => set.delete(callback);
    },
    emit(event, ...args) { for (const callback of listeners.get(event) ?? []) callback(...args); },
    step(event, next = async () => ({ kind: 'enter', messages: [] })) {
      const callbacks = [...listeners.get('agent/pre-step') ?? []];
      const advance = index => index === callbacks.length ? next() : callbacks[index](event, () => advance(index + 1));
      return advance(0);
    },
    count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
}
const step = (target, modelSelection = selected, turn = 1, number = 1) => ({ agent: target, messages: [], turn, step: number, modelSelection });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function reviewFixture() {
  const snapshot = { schemaVersion: 1, snapshotId: 'synthetic-snapshot', capturedAt: '2026-11-06T00:00:00Z',
    scope: { scopeId: 'scope', sessionId: 'synthetic-agent', agentId: 'synthetic-agent', memoryRootId: 'synthetic-memory' },
    sources: [{ sourceId: 'memory', path: 'long-term.md', role: 'longTerm', content: 'Synthetic event.\n', version: 1, writable: true, sensitivity: 'private', protectedText: [] }] };
  const proposal = { schemaVersion: 1, jobId: 'job', proposalId: 'proposal', kind: 'fact', text: 'Synthetic event.', reason: 'Synthetic evidence.',
    targetId: 'memory', operation: 'retain', before: 'Synthetic event.\n', after: 'Synthetic event.\n', evidence: [{ sourceId: 'memory', quote: 'Synthetic event.' }] };
  return { snapshot, proposal };
}
const verdict = JSON.stringify({ decision: 'defer', reason: 'Synthetic route test, not approval.' });

// Contract fixtures only: no Host service invocation, network, credentials, or memory.
test('rc.1 pending selection wins over the old header without inheriting its effort or route controls', async () => {
  const target = agent(); target.options.maxTokens = 321;
  const ctx = context();
  await createHostModel(ctx, target)('Synthetic input.');
  assert.deepEqual(ctx.configs, [{ ...selected, maxTokens: 321 }]);
  assert.equal(Object.hasOwn(ctx.configs[0], 'reasoningEffort'), false);
});

test('same-route Auto removes effective header effort and cap but retains explicit sampling controls', () => {
  const target = agent({ provider: old.provider, model: old.model });
  target.session.requestHeader = () => ({ config: old, adapterDefaults: { reasoningEffort: true, maxTokens: true } });
  assert.deepEqual(captureModelCall(target), { provider: old.provider, model: old.model, temperature: old.temperature, stop: old.stop });
  target.options.maxTokens = 73;
  assert.equal(captureModelCall(target).maxTokens, 73);
  target.model.current = () => ({ provider: old.provider, model: old.model, reasoningEffort: 'low' });
  assert.equal(captureModelCall(target).reasoningEffort, 'low');
});

test('same-route explicit controls are copied and live output cap takes priority', () => {
  const target = agent({ provider: old.provider, model: old.model });
  const config = captureModelCall(target);
  assert.deepEqual(config, { provider: old.provider, model: old.model, maxTokens: 2048, temperature: 0.8, stop: ['OLD'] });
  config.stop.push('MUTATED');
  assert.deepEqual(old.stop, ['OLD']);
  target.options.maxTokens = 12;
  assert.equal(captureModelCall(target).maxTokens, 12);
});

test('legacy fallback remains explicit and honors header adapter-default flags', () => {
  const target = agent(); delete target.model;
  assert.deepEqual(captureModelCall(target), old);
  target.session.requestHeader = () => ({ config: old, adapterDefaults: { reasoningEffort: true, maxTokens: true } });
  assert.deepEqual(captureModelCall(target), { provider: old.provider, model: old.model, temperature: old.temperature, stop: old.stop });
  delete target.session.requestHeader;
  target.options = { provider: 'legacy', model: 'legacy-model', reasoningEffort: 'low', maxTokens: 99, temperature: 0, stop: ['END'] };
  assert.deepEqual(captureModelCall(target), target.options);
  assert.notEqual(captureModelCall(target).stop, target.options.stop);
});

test('present-but-invalid current() never silently revives an old header', async () => {
  for (const current of [() => undefined, () => null, () => ({}), () => ({ provider: ' ', model: 'm' }), () => ({ provider: 'p', model: 1 })]) {
    const target = agent(); target.model.current = current;
    const ctx = context();
    await assert.rejects(createHostModel(ctx, target)('Synthetic input.'), /provider\/model/);
    assert.equal(ctx.configs.length, 0);
  }
  const target = agent(); target.model = {};
  assert.throws(() => captureModelCall(target), /current/);
  const failure = new Error('selection read failed');
  target.model.current = () => { throw failure; };
  assert.throws(() => captureModelCall(target), error => error === failure);
});

test('selected and prepared controls reject invalid values instead of passing arbitrary objects', async () => {
  for (const invalid of [{ maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: null }, { reasoningEffort: '' }, { reasoningEffort: {} },
    { temperature: NaN }, { temperature: Infinity }, { temperature: '0' }, { stop: 'END' }, { stop: [1] }, { stop: Array(1) }, { stop: null }]) {
    assert.throws(() => copyCallConfig({ ...selected, ...invalid }), /Invalid model/);
    const ctx = context(undefined, config => ({ ...config, ...invalid }));
    await assert.rejects(createHostModel(ctx, agent())('Synthetic input.'), /Invalid model/);
    assert.equal(ctx.inputs.length, 0);
  }
  const target = agent(); target.options.maxTokens = null;
  assert.throws(() => captureModelCall(target), /maxTokens/);
});

test('capture freezes a whole background admission but each stage retains a fresh UUID and clean prompt', async () => {
  let selection = { ...selected, reasoningEffort: 'low' };
  const target = agent(); target.model.current = () => selection;
  target.options.maxTokens = 123;
  const ctx = context(undefined, config => { config.stop?.push('ADAPTER_MUTATION'); return { ...config, system: 'NEVER', tools: ['NEVER'], replayState: 'NEVER' }; });
  const model = createHostModel(ctx, target);
  const captured = model.capture();
  selection = { provider: 'next', model: 'next-model', reasoningEffort: 'high' };
  target.options.maxTokens = 999;
  await captured('First stage.'); await captured('Second stage.'); await model('Next task.');
  assert.deepEqual(ctx.configs, [{ ...selected, reasoningEffort: 'low', maxTokens: 123 }, { ...selected, reasoningEffort: 'low', maxTokens: 123 }, { ...selection, maxTokens: 999 }]);
  assert.equal(new Set(ctx.inputs.map(input => input.sessionId)).size, 3);
  assert.deepEqual(ctx.inputs.map(input => input.messages), ['First stage.', 'Second stage.', 'Next task.'].map(text => [{ role: 'user', content: [{ type: 'text', text }] }]));
  for (const input of ctx.inputs) {
    assert.notEqual(input.sessionId, target.session.id);
    assert.equal(Object.hasOwn(input, 'system'), false);
    assert.equal(Object.hasOwn(input, 'tools'), false);
    assert.equal(Object.hasOwn(input, 'replayState'), false);
  }
});

test('each captured stage receives an independent control copy', async () => {
  const target = agent({ provider: old.provider, model: old.model });
  const ctx = context(undefined, config => { config.stop.push('ADAPTER_MUTATION'); return config; });
  const captured = createHostModel(ctx, target).capture();
  await captured('Stage one.'); await captured('Stage two.');
  assert.deepEqual(ctx.configs.map(config => config.stop), [['OLD'], ['OLD']]);
});

test('tracker records only an accepted target step, preserves waterfall decisions and returns detached selection', async () => {
  const target = agent(); const ctx = events(); const tracker = createModelSelectionTracker(ctx, target);
  const gate = deferred(); const mutable = { ...selected, reasoningEffort: 'low' };
  const decision = { kind: 'enter', messages: [{ synthetic: true }], startsRequestSeries: true };
  const entering = ctx.step(step(target, mutable), async () => { await gate.promise; return decision; });
  assert.equal(tracker.current(), undefined);
  mutable.model = 'changed'; gate.resolve(); assert.equal(await entering, decision);
  assert.deepEqual(tracker.current(), { ...selected, reasoningEffort: 'low' });
  tracker.current().model = 'not retained';
  assert.equal(tracker.current().model, selected.model);
  await ctx.step(step(agent(), { provider: 'other', model: 'other' }));
  assert.equal(tracker.current().model, selected.model);
  await ctx.step(step(target, selected, 1, 2), async () => ({ kind: 'reject' }));
  assert.equal(tracker.current(), undefined);
  tracker.dispose(); tracker.dispose(); assert.equal(ctx.count(), 0);
});

test('tracker clears matching step/turn endings, ignores foreign events, and cannot revive after disposal', async () => {
  const target = agent(); const ctx = events(); const tracker = createModelSelectionTracker(ctx, target);
  await ctx.step(step(target));
  ctx.emit('session/event', agent().session, { type: 'turn/end', data: { turn: 1 } });
  ctx.emit('session/event', target.session, { type: 'step/end', data: { turn: 1, step: 9 } });
  assert.deepEqual(tracker.current(), selected);
  ctx.emit('session/event', target.session, { type: 'step/end', data: { turn: 1, step: 1 } });
  assert.equal(tracker.current(), undefined);
  await ctx.step(step(target, selected, 2, 1));
  ctx.emit('session/event', target.session, { type: 'turn/end', data: { turn: 2 } });
  assert.equal(tracker.current(), undefined);
  const gate = deferred(); const entering = ctx.step(step(target, selected, 3, 1), async () => { await gate.promise; return { kind: 'enter' }; });
  tracker.dispose(); gate.resolve(); await entering;
  assert.equal(tracker.current(), undefined); assert.equal(ctx.count(), 0);
});

test('invalid and failed step admission cannot retain a previous selection', async () => {
  const target = agent(); const ctx = events(); const tracker = createModelSelectionTracker(ctx, target);
  await ctx.step(step(target));
  await assert.rejects(ctx.step(step(target, {})), /provider\/model/);
  assert.equal(tracker.current(), undefined);
  await ctx.step(step(target));
  await assert.rejects(ctx.step(step(target), async () => { throw new Error('admission failed'); }), /admission failed/);
  assert.equal(tracker.current(), undefined);
  tracker.dispose();
});

test('tracker rolls back first listener when second registration fails', () => {
  let removed = 0;
  const ctx = { on(name) { if (name === 'session/event') throw new Error('registration failure'); return () => { removed++; }; } };
  assert.throws(() => createModelSelectionTracker(ctx, agent()), /registration failure/);
  assert.equal(removed, 1);
});

test('step review uses accepted Auto selection rather than newer pending choice and attests actual prepared route', async () => {
  const target = agent({ provider: 'pending', model: 'pending-model', reasoningEffort: 'high' });
  target.options.maxTokens = 71;
  target.session.requestHeader = () => ({ config: { ...old, ...selected }, adapterDefaults: { reasoningEffort: true } });
  const ctx = events(); const tracker = createModelSelectionTracker(ctx, target);
  await ctx.step(step(target));
  const llm = context(verdict, config => ({ ...config, provider: 'actual', model: 'actual-model', reasoningEffort: 'resolved-default' }));
  const { snapshot, proposal } = reviewFixture();
  const result = await createCleanReviewer(llm, target, { modelSelection: tracker.current })(snapshot, proposal);
  assert.deepEqual(llm.configs[0], { ...selected, maxTokens: 71, temperature: old.temperature, stop: old.stop });
  assert.equal(result.authority.provider, 'actual'); assert.equal(result.authority.model, 'actual-model');
  assert.equal(llm.inputs[0].reasoningEffort, 'resolved-default');
  assert.notEqual(llm.inputs[0].sessionId, target.session.id);
  assert.equal(Object.hasOwn(llm.inputs[0], 'system'), false);
  tracker.dispose();
});

test('configured review tracker without active selection fails closed instead of falling back to pending current', async () => {
  const ctx = context(verdict); const { snapshot, proposal } = reviewFixture();
  await assert.rejects(createCleanReviewer(ctx, agent(), { modelSelection: () => undefined })(snapshot, proposal), /captured active-step/);
  assert.equal(ctx.configs.length, 0);
  await createCleanReviewer(ctx, agent())(snapshot, proposal);
  assert.deepEqual(ctx.configs[0], selected, 'untracked direct calls use authoritative current()');
});

test('cancellation during synchronous selection cannot dispatch review preparation', async () => {
  const controller = new AbortController(); const ctx = context(verdict); const { snapshot, proposal } = reviewFixture();
  const review = createCleanReviewer(ctx, agent(), { modelSelection: () => { controller.abort(new Error('cancel while selecting')); return selected; } });
  await assert.rejects(review(snapshot, proposal, { signal: controller.signal }), /cancel while selecting/);
  assert.equal(ctx.configs.length, 0);
});

test('review snapshots a mutable selection once before preparation and keeps actual authority detached', async () => {
  let reads = 0; const mutable = { ...selected, reasoningEffort: 'low' }; const gate = deferred();
  const ctx = context(verdict, async config => { await gate.promise; return config; });
  const { snapshot, proposal } = reviewFixture();
  const pending = createCleanReviewer(ctx, agent(), { modelSelection: () => { reads++; return mutable; } })(snapshot, proposal);
  mutable.provider = 'later'; mutable.model = 'later-model'; mutable.reasoningEffort = 'high'; gate.resolve();
  const result = await pending;
  assert.equal(reads, 1); assert.deepEqual(ctx.configs[0], { ...selected, reasoningEffort: 'low' });
  assert.equal(result.authority.provider, selected.provider);
});
