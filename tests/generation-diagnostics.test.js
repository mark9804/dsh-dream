import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { createHostModel } from '../dist/harness/model.js';
import { validateGenerationDiagnostics } from '../dist/domain/generation-diagnostics.js';
import { validateJob } from '../dist/domain/contracts.js';
import { createEngine } from '../dist/engine.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { validateConfig } from '../dist/config.js';
const snapshot = { schemaVersion: 1, snapshotId: 'synthetic-snapshot', capturedAt: '2026-11-08T00:00:00Z',
  scope: { scopeId: 'test', agentId: 'synthetic', sessionId: 'synthetic', memoryRootId: 'memory' },
  sources: [{ sourceId: 'daily', path: 'daily/2026-11-08.md', role: 'daily', content: 'SYNTHETIC_PRIVATE_CANARY river.', version: 1, writable: false, sensitivity: 'private', protectedText: [] }] };
const limits = { timeoutMs: 5000, maxOutputBytes: 4096, maxProposals: 2, maxEpisodes: 2 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = prompt => prompt.startsWith('ORGANIZE：') ? { episodes: [], coveredSourceIds: ['daily'] } : { proposals: [] };
const agent = { id: 'synthetic', session: { id: 'synthetic' }, options: { provider: 'fake-provider', model: 'fake-model' } };
function hostModel(stream) { return createHostModel({ llm: { async prepareCall(config) { return { config, stream }; } } }, agent); }

test('two stage diagnostics contain route, first token, usage, bytes and real settlement, never any source/model text', async () => {
  const values = [];
  const model = hostModel(async function* (input) {
    yield { type: 'reasoning-delta', index: 0, text: 'SYNTHETIC_SECRET_REASONING' };
    const text = JSON.stringify(response(input.messages[0].content[0].text));
    yield { type: 'text-delta', index: 1, text };
    yield { type: 'usage', usage: { inputTokens: 33, outputTokens: 12, reasoningTokens: 5, hidden: 'DO_NOT_COPY' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const result = await createWorkerGenerator(model, limits, 'memory-v2')(snapshot, 'job', { onDiagnostic: value => { values.push(value); } });
  assert.equal(result.mode, 'memory-v2'); const d = values.at(-1); validateGenerationDiagnostics(d);
  assert.deepEqual(d.stages.map(s => s.stage), ['starting', 'organize', 'deep', 'validation']);
  assert.equal(d.state, 'completed'); assert.ok(d.settledAt); assert.equal(d.calls.length, 2);
  for (const call of d.calls) {
    assert.equal(call.state, 'completed'); assert.equal(call.provider, 'fake-provider'); assert.ok(call.firstResponseAt); assert.ok(call.firstTokenAt); assert.ok(call.firstTextAt);
    assert.ok(call.inputBytes > 0 && call.outputBytes > 0 && call.reasoningBytes > 0); assert.deepEqual(call.usage, { inputTokens: 33, outputTokens: 12, reasoningTokens: 5 });
  }
  assert.notEqual(d.calls[0].callId, d.calls[1].callId);
  assert.doesNotMatch(JSON.stringify(values), /SYNTHETIC_PRIVATE_CANARY|SYNTHETIC_SECRET_REASONING|coveredSourceIds|DO_NOT_COPY|proposals/);
  values[0].input.sourceCount = 999; assert.equal(d.input.sourceCount, 1, 'observer payloads are detached');
});

test('DEEP timeout preserves completed ORGANIZE, reports dedicated code and waits for actual model drain', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const entered = deferred(), release = deferred(), values = []; let calls = 0, secondSignal;
  const generate = createWorkerGenerator(async (prompt, { signal }) => {
    calls++; if (calls === 1) return JSON.stringify(response(prompt));
    secondSignal = signal; entered.resolve(); await release.promise; return JSON.stringify({ proposals: [] });
  }, limits, 'memory-v2');
  const pending = generate(snapshot, 'job', { onDiagnostic: d => { values.push(d); } });
  const rejected = assert.rejects(pending, error => error.code === 'DREAM_EXECUTOR_TIMEOUT' && /during deep/.test(error.message));
  await entered.promise; t.mock.timers.tick(limits.timeoutMs); assert.equal(secondSignal.aborted, true);
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; }); await new Promise(setImmediate); assert.equal(settled, false);
  assert.equal(values.at(-1).state, 'timed_out'); assert.equal(values.at(-1).settledAt, undefined);
  release.resolve(); await rejected;
  const d = values.at(-1); assert.ok(d.settledAt); assert.equal(d.stage, 'deep'); assert.deepEqual(d.calls.map(c => c.state), ['completed', 'cancelled']);
  assert.equal(calls, 2);
});

test('a slow progress sink cannot dispatch prepare/stream after caller cancellation', async () => {
  for (const boundary of ['preparing', 'streaming']) {
    const entered = deferred(), release = deferred(), stop = new AbortController(); let prepared = 0, streamed = 0;
    const model = createHostModel({ llm: { async prepareCall(config) { prepared++; return { config, async *stream() { streamed++; yield { type: 'text-delta', index: 0, text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }; } } }, agent);
    const work = model('synthetic', { signal: stop.signal, onProgress: async progress => { if (progress.state === boundary && !stop.signal.aborted) { entered.resolve(); await release.promise; } } });
    const rejected = assert.rejects(work, /fixture stopped/); await entered.promise; stop.abort(Error('fixture stopped')); release.resolve(); await rejected;
    assert.equal(prepared, boundary === 'preparing' ? 0 : 1); assert.equal(streamed, 0);
  }
});

test('provider failure code and request ID survive worker transport without raw error text in diagnostics', async () => {
  const values = [], model = hostModel(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'SYNTHETIC_RAW_ERROR_CANARY', requestId: 'provider-request-test' } } }; });
  await assert.rejects(createWorkerGenerator(model, limits, 'memory-v2')(snapshot, 'job', { onDiagnostic: d => { values.push(d); } }), error => error.code === 'RATE_LIMIT');
  const d = values.at(-1); assert.equal(d.failureCode, 'RATE_LIMIT'); assert.equal(d.calls[0].failureCode, 'RATE_LIMIT'); assert.equal(d.calls[0].providerRequestId, 'provider-request-test');
  assert.doesNotMatch(JSON.stringify(values), /SYNTHETIC_RAW_ERROR_CANARY/);
});

test('diagnostic persistence failure cancels generation rather than returning an unaudited success', async () => {
  let models = 0;
  await assert.rejects(createWorkerGenerator(async () => { models++; return '{}'; }, limits, 'memory-v2')(snapshot, 'job', { onDiagnostic() { throw Error('synthetic storage failure'); } }), error => error.code === 'GENERATION_DIAGNOSTIC_FAILED');
  assert.equal(models, 0);
});

test('terminal and settled diagnostic storage failures return the stable persistence code', async () => {
  for (const boundary of ['terminal', 'settled']) {
    await assert.rejects(createWorkerGenerator(async prompt => JSON.stringify(response(prompt)), limits, 'memory-v2')(snapshot, 'job', { onDiagnostic(d) {
      if (d.state === 'completed' && (boundary === 'terminal' || d.settledAt)) throw Error('raw disk failure');
    } }), error => error.code === 'GENERATION_DIAGNOSTIC_FAILED' && !error.message.includes('raw disk'));
  }
});

test('pre-aborted execution and capture-time abort never dispatch a model', async () => {
  for (const duringCapture of [false, true]) {
    const stop = new AbortController(); let calls = 0;
    const model = Object.assign(async () => { calls++; return '{}'; }, { capture() { stop.abort(Error('capture stopped')); return model; } });
    if (!duringCapture) stop.abort(Error('pre stopped'));
    await assert.rejects(createWorkerGenerator(model, limits, 'memory-v2')(snapshot, 'job', { signal: stop.signal })); assert.equal(calls, 0);
  }
});

test('diagnostic schema rejects text injection while older stored jobs remain readable', async () => {
  const values = [];
  await createWorkerGenerator(async prompt => JSON.stringify(response(prompt)), limits, 'memory-v2')(snapshot, 'job', { onDiagnostic: d => { values.push(d); } });
  const good = values.at(-1);
  for (const mutate of [d => { d.prompt = 'canary'; }, d => { d.calls[0].outputText = 'canary'; }, d => { d.calls[0].usage = { inputTokens: -1 }; }, d => { d.stages[0].stage = 'arbitrary'; }]) {
    const value = structuredClone(good); mutate(value); assert.throws(() => validateGenerationDiagnostics(value), /diagnostic/);
  }
  assert.equal(validateJob({ schemaVersion: 1, jobId: 'old', scope: snapshot.scope, snapshot, state: 'generating', proposals: [], reviews: [], appliedProposalIds: [], createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt }).generationDiagnostics, undefined);
});

test('engine persists progress before finish and status still exposes it after constructing a fresh engine', async () => {
  const parent = new URL('./.tmp/', import.meta.url); await mkdir(parent, { recursive: true }); const root = await mkdtemp(new URL('generation-diagnostics-', parent).pathname);
  const files = createLocalFiles(root), config = validateConfig({ sessionId: 'synthetic', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state', timeZone: 'Asia/Tokyo', dreamMode: 'off' });
  const store = createStore(files, { root: 'state', lockKey: 'synthetic' });
  const job = { schemaVersion: 1, jobId: 'job', scope: snapshot.scope, snapshot, state: 'failed', phase: 'generating', checkpoint: { state: 'generating' }, error: { code: 'FAILED', message: 'old timeout' }, proposals: [], reviews: [], appliedProposalIds: [], createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt };
  // Exact copied-source namespace maps only into this synthetic confined filesystem.
  const configured = { ...config, memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' };
  await files.mkdir('memory/daily'); await files.write('memory/daily/2026-11-08.md', snapshot.sources[0].content, null);
  const mapped = { ...files, read: (p, o) => files.read(p.startsWith('/synthetic/memory/') ? p.replace('/synthetic/memory/', 'memory/') : p, o) };
  await store.saveJob(job); let next = 0; const entered = deferred(), release = deferred();
  const generate = createWorkerGenerator(async prompt => { if (prompt.startsWith('ORGANIZE：')) return JSON.stringify(response(prompt)); entered.resolve(); await release.promise; return JSON.stringify({ proposals: [] }); }, limits, 'memory-v2');
  const host = { async waitForIdle() {}, async notify() {}, async requestReview() {}, async requestReload() {} };
  const options = { config: configured, scope: snapshot.scope, files: mapped, store, generate, host, id: () => `id-${++next}`, now: () => new Date('2026-11-08T05:30:00+09:00') };
  const engine = createEngine(options); await engine.retry({ jobId: 'job' }); await entered.promise;
  const mid = await store.loadJob('job'); assert.equal(mid.generationDiagnostics.stage, 'deep'); assert.equal(mid.generationDiagnostics.calls.length, 2);
  release.resolve(); await engine.flush();
  const restarted = createEngine(options), detail = await restarted.status({ jobId: 'job' });
  assert.equal(detail.state, 'reviewed_no_changes'); assert.equal(detail.generationDiagnostics.state, 'completed'); assert.ok(detail.generationDiagnostics.settledAt);
  assert.equal((await restarted.status({})).jobs[0].generationDiagnostics.state, 'completed');
  assert.ok(root.includes('tests/.tmp/')); assert.ok(join(root, 'state'));
});
