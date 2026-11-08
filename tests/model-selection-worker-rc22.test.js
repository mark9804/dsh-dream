import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostModel } from '../dist/harness/model.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { createFreeDreamWriter } from '../dist/dream/free-executor.js';

const snapshot = {
  schemaVersion: 1, snapshotId: 'synthetic-worker-snapshot', capturedAt: '2026-11-06T00:00:00Z',
  scope: { scopeId: 'scope', sessionId: 'synthetic-parent', agentId: 'synthetic-parent', memoryRootId: 'synthetic-memory' },
  sources: [{ sourceId: 'daily', path: 'daily/2026-11-06.md', role: 'daily', content: 'Synthetic meeting by the river.', version: 1, writable: false, sensitivity: 'private', protectedText: [] }],
};
const digestOutput = { coveredSourceIds: ['daily'], episodes: [] };
const route = { provider: 'admitted', model: 'admitted-model' };
const later = { provider: 'later', model: 'later-model', reasoningEffort: 'high' };
function fixture(response) {
  let selected = { ...route };
  let reads = 0;
  const configurations = [], inputs = [];
  const agent = {
    id: 'synthetic-parent', session: { id: 'synthetic-parent', requestHeader: () => ({
      config: { ...route, reasoningEffort: 'old-auto', maxTokens: 1000, temperature: 0, stop: ['END'] },
      adapterDefaults: { reasoningEffort: true, maxTokens: true },
    }) },
    model: { current() { reads++; return selected; } },
    options: { maxTokens: 71 },
  };
  const ctx = { llm: { async prepareCall(config) {
    configurations.push(structuredClone(config));
    return { config, async *stream(input) {
      inputs.push(input);
      const prompt = input.messages[0].content[0].text;
      yield { type: 'text-delta', index: 0, text: JSON.stringify(response(prompt)) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } } };
  return { model: createHostModel(ctx, agent), agent, configurations, inputs,
    switch() { selected = { ...later }; agent.options.maxTokens = 99; }, reads: () => reads };
}

// Real worker orchestration, but only synthetic prepared-stream mocks; no Host or network.
test('memory-v2 worker captures once before startup and keeps both stages on the admitted route', async () => {
  const f = fixture(prompt => prompt.startsWith('ORGANIZE：') ? digestOutput : { proposals: [] });
  const generate = createWorkerGenerator(f.model, { timeoutMs: 5000, maxOutputBytes: 4096, maxProposals: 2, maxEpisodes: 2 }, 'memory-v2');
  const pending = generate(snapshot, 'synthetic-worker-job');
  assert.equal(f.reads(), 1, 'selection is captured synchronously before worker startup');
  f.switch();
  const result = await pending;
  assert.equal(result.mode, 'memory-v2');
  assert.deepEqual(result.proposals, []);
  assert.equal(f.reads(), 1, 'stage callbacks must not read a later current() selection');
  const admitted = { ...route, maxTokens: 71, temperature: 0, stop: ['END'] };
  assert.deepEqual(f.configurations, [admitted, admitted]);
  assert.match(f.inputs[0].messages[0].content[0].text, /^ORGANIZE：/);
  assert.match(f.inputs[1].messages[0].content[0].text, /\nDEEP：/);
  assert.notEqual(f.inputs[0].sessionId, f.inputs[1].sessionId);
  for (const input of f.inputs) {
    assert.notEqual(input.sessionId, f.agent.session.id);
    assert.equal(input.messages.length, 1);
    assert.equal(Object.hasOwn(input, 'reasoningEffort'), false, 'Auto is not the old effective effort');
    for (const key of ['system', 'tools', 'history', 'toolHistory', 'replayState']) assert.equal(Object.hasOwn(input, key), false);
  }
  await generate(snapshot, 'synthetic-next-job');
  assert.equal(f.reads(), 2, 'a later job admits the new choice once');
  assert.deepEqual(f.configurations.slice(2), [{ ...later, maxTokens: 99 }, { ...later, maxTokens: 99 }]);
});

test('independent free-dream worker also captures before its first asynchronous model request', async () => {
  const f = fixture(() => ({ dream: 'A synthetic river rose into the sky.', afterFeeling: '' }));
  const writer = createFreeDreamWriter(f.model, { timeoutMs: 5000, maxOutputBytes: 4096 });
  const input = { schemaVersion: 1, jobId: 'synthetic-dream-job', snapshotId: snapshot.snapshotId,
    episodes: { schemaVersion: 1, snapshotId: snapshot.snapshotId, episodes: [], coverage: { sourceIds: ['daily'], omittedSourceIds: [] } },
    conversation: { messages: [], coverage: { requested: 0, included: 0, omitted: 0, unavailable: 0, reasons: [] } } };
  const pending = writer(input);
  assert.equal(f.reads(), 1);
  f.switch();
  assert.equal((await pending).dream, 'A synthetic river rose into the sky.');
  assert.deepEqual(f.configurations, [{ ...route, maxTokens: 71, temperature: 0, stop: ['END'] }]);
  assert.equal(f.reads(), 1);
});
