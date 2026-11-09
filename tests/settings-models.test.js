import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDreamModelCatalog, validateModelChoices } from '../dist/settings/models.js';
import { createSettingsService } from '../dist/settings/service.js';
function fixture() {
  const calls = [], metadata = { provider: 'native', id: 'model-A', name: 'Model A', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'custom-depth-7', name: 'Custom depth' }], defaultEffort: 'custom-depth-7' } };
  const agent = { model: { current: () => ({ provider: 'native', model: 'model-A', reasoningEffort: 'custom-depth-7' }) } };
  const llm = {
    listProviders() { calls.push('providers'); return [{ id: 'native', name: 'Native' }, { id: 'broken', name: 'Broken' }]; },
    async listModels(provider) { calls.push(['models', provider]); if (provider === 'broken') throw Error('private credential should never leak'); return [{ provider, id: 'model-A', name: 'Model A' }]; },
    async resolveModelInfo(provider, model, signal) { calls.push(['resolve', provider, model]); signal?.throwIfAborted(); return metadata; },
    prepareCall() { throw Error('Catalog must never prepare a generation'); }, stream() { throw Error('Catalog must not stream'); },
  };
  return { ctx: { llm }, agent, calls, metadata };
}
test('directory reads real adapter capability ids and projects only public metadata', async () => {
  const f = fixture(), view = await buildDreamModelCatalog(f.ctx, f.agent);
  assert.deepEqual(view.current, { provider: 'native', model: 'model-A', reasoningEffort: 'custom-depth-7' });
  assert.deepEqual(view.groups[0].models[0].reasoning.efforts.map(e => e.id), ['off', 'custom-depth-7']);
  assert.equal(view.failures[0].id, 'broken'); assert.ok(!JSON.stringify(view).includes('credential'));
  view.groups[0].models[0].reasoning.efforts[0].id = 'mutated'; assert.equal(f.metadata.reasoning.efforts[0].id, 'off');
});
test('only actual exact-model efforts are selectable and no hardcoded low/high aliases exist', async () => {
  const f = fixture();
  assert.deepEqual(await validateModelChoices(f.ctx, {}, f.agent), []); assert.deepEqual(f.calls, []);
  assert.deepEqual(await validateModelChoices(f.ctx, { memoryModel: { reasoningEffort: 'custom-depth-7' }, dreamModel: { provider: 'native', model: 'model-A' } }, f.agent), []);
  assert.deepEqual((await validateModelChoices(f.ctx, { reviewModel: { provider: 'native', model: 'model-A', reasoningEffort: 'max' } }, f.agent)).map(e => e.field), ['reviewModel']);
  assert.deepEqual((await validateModelChoices(f.ctx, { memoryModel: { provider: 'native', model: 'missing' } }, f.agent)).map(e => e.field), ['memoryModel']);
});
test('capability absence is not invented reasoning support and invalid provider group is isolated', async () => {
  const f = fixture(); delete f.metadata.reasoning;
  assert.deepEqual(await validateModelChoices(f.ctx, { memoryModel: { provider: 'native', model: 'model-A' } }, f.agent), []);
  assert.equal((await validateModelChoices(f.ctx, { memoryModel: { reasoningEffort: 'off' } }, f.agent)).length, 1);
  f.metadata.reasoning = { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'invented' };
  assert.deepEqual((await buildDreamModelCatalog(f.ctx)).groups, []);
});
test('one broken model never hides a healthy sibling route from selection', async () => {
  const f = fixture(), resolve = f.ctx.llm.resolveModelInfo;
  f.ctx.llm.listModels = async provider => provider === 'native' ? [{ provider, id: 'model-A', name: 'Model A' }, { provider, id: 'broken-model', name: 'Broken model' }] : [];
  f.ctx.llm.resolveModelInfo = async (provider, model, signal) => { if (model === 'broken-model') throw Error('Private adapter error'); return resolve(provider, model, signal); };
  const catalog = await buildDreamModelCatalog(f.ctx, f.agent);
  assert.deepEqual(catalog.groups[0].models.map(model => model.id), ['model-A']); assert.equal(catalog.failures[0].id, 'native/broken-model');
  assert.deepEqual(await validateModelChoices(f.ctx, { reviewModel: { provider: 'native', model: 'model-A' } }, f.agent), []);
});
test('catalog uses no persisted header fallback when live current selection is explicitly absent', async () => {
  const f = fixture(); f.agent.model.current = () => undefined;
  f.agent.session = { requestHeader: () => ({ config: { provider: 'native', model: 'old-header' } }) };
  const view = await buildDreamModelCatalog(f.ctx, f.agent); assert.equal(view.current, undefined); assert.equal(view.groups.length, 1);
});
test('catalog cancellation propagates and missing service is explicit unavailable, no fallback requests', async () => {
  const f = fixture(), stop = new AbortController(); stop.abort(new Error('cancelled catalog'));
  await assert.rejects(buildDreamModelCatalog(f.ctx, f.agent, stop.signal), /cancelled catalog/); assert.deepEqual(f.calls, []);
  await assert.rejects(buildDreamModelCatalog({ llm: {} }), error => error.code === 'UNAVAILABLE');
});
test('settings models endpoint is read-only, supports disabled empty setup and rejects extra inputs', async () => {
  const f = fixture(), denied = () => { throw Error('Unexpected state access'); };
  const ctx = { ...f.ctx, agents: { get(id) { assert.equal(id, 'target'); return undefined; } }, get() {}, fs: { readText: denied, writeText: denied }, tools: { register: denied } };
  const service = createSettingsService(ctx); const view = await service.models({}); assert.equal(view.groups[0].id, 'native');
  assert.equal((await service.models({ sessionId: 'target' })).groups.length, 1);
  await assert.rejects(service.models({ provider: 'native' }), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(service.models({ sessionId: '' }), error => error.code === 'INVALID_REQUEST');
});
