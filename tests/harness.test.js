import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHostModel } from '../dist/harness/model.js';
import { createHostControl } from '../dist/harness/control.js';
import { registerTools } from '../dist/harness/tools.js';
import { createHostFiles } from '../dist/harness/files.js';

const makeAgent = () => ({ id: 'session-a', session: { id: 'session-a', requestHeader: () => ({ config: { provider: 'chosen', model: 'current' } }) }, options: { provider: 'old', model: 'old' } });

function modelContext(chunks, seen = {}) {
  return { llm: { async prepareCall(config, signal) {
    seen.config = config;
    seen.signal = signal;
    return { config: { ...config, maxTokens: 2000 }, async *stream(options) {
      seen.options = options;
      for (const chunk of chunks) yield chunk;
    } };
  } } };
}

test('model uses the current Host route and does not duplicate completed blocks', async () => {
  const seen = {};
  const signal = new AbortController().signal;
  const generate = createHostModel(modelContext([
    { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
    { type: 'text-delta', index: 1, text: 'hel' },
    { type: 'text-delta', index: 1, text: 'lo' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ], seen), makeAgent());
  assert.equal(await generate('synthetic materials', { signal }), 'hello');
  assert.deepEqual(seen.config, { provider: 'chosen', model: 'current' });
  assert.equal(seen.options.maxTokens, 2000);
  assert.equal(seen.options.signal, signal);
  assert.notEqual(seen.options.sessionId, 'session-a');
  assert.match(seen.options.sessionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(seen.options.tools, undefined);
});

test('model preserves all session call controls and dispatches their detached prepared values', async () => {
  for (const fromHeader of [true, false]) {
    const agent = makeAgent();
    const target = { provider: 'selected', model: 'synthetic', maxTokens: 123,
      reasoningEffort: 'low', temperature: 0, stop: ['END'], unrelatedOption: 'omit' };
    if (fromHeader) agent.session.requestHeader = () => ({ config: target });
    else { delete agent.session.requestHeader; agent.options = target; }
    let preparedCalls = 0;
    const ctx = { llm: { async prepareCall(config) {
      preparedCalls++;
      assert.deepEqual(config, { provider: 'selected', model: 'synthetic', maxTokens: 123,
        reasoningEffort: 'low', temperature: 0, stop: ['END'] });
      assert.notEqual(config.stop, target.stop);
      const preparedConfig = { ...config, reasoningEffort: 'resolved' };
      return { config: preparedConfig, async *stream(options) {
        for (const key of Object.keys(preparedConfig)) assert.deepEqual(options[key], preparedConfig[key]);
        assert.notEqual(options.stop, preparedConfig.stop);
        assert.equal(options.tools, undefined);
        yield { type: 'text-delta', index: 0, text: 'synthetic' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    } } };
    assert.equal(await createHostModel(ctx, agent)('synthetic input'), 'synthetic');
    assert.equal(preparedCalls, 1);
    assert.equal(target.reasoningEffort, 'low');
  }
});

test('model does not dispatch when cancellation occurs during preparation', async () => {
  const controller = new AbortController();
  const ctx = { llm: { async prepareCall() {
    controller.abort(new Error('cancel during preparation'));
    return { config: {}, stream() { assert.fail('must not dispatch after cancellation'); } };
  } } };
  await assert.rejects(createHostModel(ctx, makeAgent())('synthetic input', { signal: controller.signal }), /cancel during preparation/);
});

test('model rejects missing finish, truncation, errors, tools and oversize output', async () => {
  const text = { type: 'text-delta', index: 0, text: 'valid-looking JSON' };
  await assert.rejects(createHostModel(modelContext([text]), makeAgent())('input'), /without a finish/);
  for (const kind of ['max-tokens', 'error', 'aborted']) {
    await assert.rejects(createHostModel(modelContext([text, { type: 'finish', reason: { kind } }]), makeAgent())('input'), /did not finish successfully/);
  }
  await assert.rejects(createHostModel(modelContext([text]), makeAgent(), { maxOutputBytes: 2 })('input'), /byte limit/);
  await assert.rejects(createHostModel(modelContext([{ type: 'tool-call-delta' }]), makeAgent())('input'), /must not invoke tools/);
  const signal = AbortSignal.abort(new Error('cancelled by test'));
  await assert.rejects(createHostModel(modelContext([]), makeAgent())('input', { signal }), /cancelled by test/);
});

test('control sends complete sourced messages without claiming reload completion', async () => {
  const agent = makeAgent();
  const messages = [];
  agent.followup = message => messages.push(message);
  const control = createHostControl({}, agent);
  const id = await control.requestReload('Read the synthetic sources then acknowledge.', { messageId: 'message-a', jobId: 'job-a', transactionId: 'tx-a' });
  assert.equal(id, 'message-a');
  assert.deepEqual(messages[0], {
    id: 'message-a', role: 'user', content: [{ type: 'text', text: 'Read the synthetic sources then acknowledge.' }],
    source: { kind: 'dsh-dream', purpose: 'reload', jobId: 'job-a', transactionId: 'tx-a' },
  });
});

test('compaction waits for idle, propagates null and errors, and can cancel the wait', async () => {
  const agent = makeAgent();
  let release;
  agent.whenIdle = () => new Promise(resolve => { release = resolve; });
  let called = false;
  const control = createHostControl({ compaction: { async compactNow(target) { assert.equal(target, agent); called = true; return null; } } }, agent);
  const result = control.compact();
  assert.equal(called, false);
  release();
  assert.equal(await result, null);
  const controller = new AbortController();
  const waiting = control.compact(controller.signal);
  controller.abort(new Error('stop waiting'));
  await assert.rejects(waiting, /stop waiting/);
  release();
  agent.whenIdle = async () => {};
  const busy = Object.assign(new Error('busy'), { code: 'busy' });
  await assert.rejects(createHostControl({ compaction: { compactNow() { throw busy; } } }, agent).compact(), error => error === busy);
});

test('waitForIdle is independently usable after review tools and is cancellable', async () => {
  const agent = makeAgent();
  let release;
  agent.whenIdle = () => new Promise(resolve => { release = resolve; });
  const control = createHostControl({}, agent);
  let completed = false;
  const waiting = control.waitForIdle().then(() => { completed = true; });
  assert.equal(completed, false);
  release();
  await waiting;
  assert.equal(completed, true);
  const controller = new AbortController();
  const cancelled = control.waitForIdle(controller.signal);
  controller.abort(new Error('cancel review continuation'));
  await assert.rejects(cancelled, /cancel review continuation/);
  release();
});

test('maintain acquires the Host maintenance window after idle and propagates external cancellation', async () => {
  const agent = makeAgent();
  const events = [];
  const maintenance = new AbortController();
  const external = new AbortController();
  agent.whenIdle = async () => { events.push('idle'); };
  agent.runMaintenance = async task => { events.push('maintenance'); return task(maintenance.signal); };
  const control = createHostControl({}, agent);
  const result = await control.maintain(signal => {
    events.push('task');
    assert.equal(signal.aborted, false);
    external.abort(new Error('cancel submission'));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, external.signal.reason);
    return 'safe checkpoint';
  }, external.signal);
  assert.equal(result, 'safe checkpoint');
  assert.deepEqual(events, ['idle', 'maintenance', 'task']);
  maintenance.abort(new Error('agent stopped'));
  await assert.rejects(control.maintain(() => assert.fail('cancelled maintenance must not execute')), /agent stopped/);
});

test('tools obtain the actor from Host, reject forged input, and unregister once', async () => {
  const agent = makeAgent();
  const tools = new Map();
  let removed = 0;
  agent.ctx = { tools: { register(definition) {
    tools.set(definition.name, definition);
    return () => { removed++; tools.delete(definition.name); };
  } } };
  let received;
  const dispose = registerTools(agent, {
    review(args, context) { received = { args, context }; return { status: 'reviewed' }; },
    ackReload() { return { status: 'acknowledged' }; },
  });
  const review = tools.get('dream_review');
  assert.deepEqual(review.parameters.properties.decision.enum, ['review', 'reject', 'defer']);
  const args = { jobId: 'job-a', proposalId: 'proposal-a', decision: 'review', reason: 'Request an independent check' };
  const controller = new AbortController();
  assert.deepEqual(await review.execute(args, { agent, signal: controller.signal }), { status: 'reviewed' });
  assert.deepEqual(received.context.actor, { agentId: 'session-a', sessionId: 'session-a' });
  assert.equal(received.context.signal, controller.signal);
  const validCall = received;
  await assert.rejects(review.execute({ ...args, decision: 'accept' }, { agent }), /Invalid decision/);
  await assert.rejects(review.execute({ ...args, authority: { kind: 'clean-model' } }, { agent }), /Unknown argument/);
  assert.equal(received, validCall, 'Invalid authority must never reach the engine');
  await assert.rejects(review.execute({ ...args, reviewer: 'session-a' }, { agent }), /Unknown argument/);
  await assert.rejects(review.execute(args, { agent: { ...agent } }), /actor does not match/);
  await assert.rejects(review.execute({ ...args, decision: 'approved' }, { agent }), /Invalid decision/);
  await assert.rejects(tools.get('dream_ack_reload').execute({ jobId: 'j', transactionId: 't', readSourceIds: ['a', 'a'] }, { agent }), /Invalid readSourceIds/);
  dispose();
  dispose();
  assert.equal(tools.size, 0);
  assert.equal(removed, 2);
});

test('PTC parent identity reaches reload handlers and cannot disappear at the adapter boundary', async () => {
  const agent = makeAgent(), tools = new Map(), parent = {};
  const ctx = { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } };
  let got;
  registerTools(agent, { readReload(_args, context) { got = context; return {}; } }, ctx);
  await tools.get('dream_reload_read').execute({ jobId: 'j', transactionId: 't' }, { agent, callId: 'child', parent });
  assert.equal(got.parent, parent); assert.equal(got.callId, 'child');
});

test('tools use the injected context and omit undefined optional output fields', async () => {
  const agent = makeAgent();
  agent.ctx = new Proxy({}, { get() { throw new Error('bare agent context must not be accessed'); } });
  const definitions = new Map();
  const injected = { tools: { register(definition) {
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  } } };
  const dispose = registerTools(agent, {
    status: async () => ({ jobs: [{ jobId: 'j', error: undefined, recovery: undefined, deliveries: {} }] }),
  }, injected);
  const result = await definitions.get('dream_status').execute({}, { agent });
  assert.deepEqual(result, { jobs: [{ jobId: 'j', deliveries: {} }] });
  assert.equal(Object.hasOwn(result.jobs[0], 'error'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  dispose();
});

test('recall and reinforcement expose bounded schemas and reject forged provenance before dispatch', async () => {
  const agent = makeAgent();
  const definitions = new Map();
  const calls = [];
  const context = { tools: { register(definition) {
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  } } };
  const dispose = registerTools(agent, {
    recall(args, actor) { calls.push({ method: 'recall', args, actor }); return { hits: [] }; },
    reinforcement(args, actor) { calls.push({ method: 'reinforcement', args, actor }); return { enabled: args.enabled }; },
  }, context);
  const recall = definitions.get('dream_recall');
  const reinforcement = definitions.get('dream_reinforcement');
  assert.equal(definitions.size, 2);
  assert.equal(recall.parameters.additionalProperties, false);
  assert.deepEqual(recall.parameters.required, ['query', 'topic', 'conditions']);
  assert.deepEqual(recall.parameters.properties.limit, { type: 'integer', description: 'Range 1–50, inclusive.' });
  assert.equal(reinforcement.parameters.additionalProperties, false);
  assert.deepEqual(reinforcement.parameters.required, ['candidateId', 'enabled', 'reason']);
  assert.deepEqual(reinforcement.parameters.properties.enabled, { type: 'boolean' });
  const request = { query: 'synthetic', topic: 'fixture', conditions: 'this fixture only' };
  const toggle = { candidateId: 'candidate', enabled: false, reason: 'Synthetic revocation.' };
  const controller = new AbortController();
  for (const limit of [undefined, 1, 50]) {
    const args = { ...request, ...(limit === undefined ? {} : { limit }) };
    assert.deepEqual(await recall.execute(args, { agent, signal: controller.signal, callId: 'recall-call' }), { hits: [] });
    assert.deepEqual(calls.at(-1).args, args);
    assert.deepEqual(calls.at(-1).actor.actor, { agentId: agent.id, sessionId: agent.session.id });
    assert.equal(calls.at(-1).actor.signal, controller.signal);
    assert.equal(calls.at(-1).actor.callId, 'recall-call');
  }
  assert.deepEqual(await reinforcement.execute(toggle, { agent }), { enabled: false });
  assert.deepEqual(await reinforcement.execute({ ...toggle, enabled: true }, { agent }), { enabled: true });
  const acceptedCount = calls.length;
  for (const args of [
    null, [], {}, { ...request, query: '' }, { ...request, topic: ' ' }, { ...request, conditions: 'x'.repeat(4097) },
    ...[0, -1, 51, 1.5, '1', NaN, Infinity].map(limit => ({ ...request, limit })),
    ...['sourceSessionIds', 'originalSources', 'ref', 'originals', 'config', 'authority', 'boost'].map(key => ({ ...request, [key]: 'forged' })),
  ]) await assert.rejects(recall.execute(args, { agent }), TypeError);
  for (const args of [
    {}, { ...toggle, candidateId: '' }, { ...toggle, reason: ' ' },
    ...[0, 1, null, 'false'].map(enabled => ({ ...toggle, enabled })),
    ...['actor', 'scope', 'originalSources', 'receipt', 'sourceSessionIds', 'reinforcementBoost'].map(key => ({ ...toggle, [key]: 'forged' })),
  ]) await assert.rejects(reinforcement.execute(args, { agent }), TypeError);
  await assert.rejects(recall.execute(request, { agent: { ...agent } }), /actor does not match/);
  await assert.rejects(reinforcement.execute(toggle, { agent: { ...agent } }), /actor does not match/);
  controller.abort(new Error('Cancel source-aware tools'));
  await assert.rejects(recall.execute(request, { agent, signal: controller.signal }), /Cancel source-aware tools/);
  await assert.rejects(reinforcement.execute(toggle, { agent, signal: controller.signal }), /Cancel source-aware tools/);
  assert.equal(calls.length, acceptedCount);
  dispose();
  assert.equal(definitions.size, 0);
});

function fileContext() {
  const entries = new Map([
    ['/memory', { type: 'directory', version: 'root' }],
    ['/state', { type: 'directory', version: 'root' }],
  ]);
  const writes = [];
  let version = 0;
  const policy = { mode: 'workspace-write', workspaceRoot: '/', sessionId: 'session-a' };
  const ctx = { sandboxPolicy: { resolve: ({ session }) => { assert.equal(session.id, 'session-a'); return policy; } }, fs: {
    sandboxMode: 'workspace-write',
    async resolve(path, { signal } = {}) { signal?.throwIfAborted(); return { targetKey: resolve(path), displayPath: resolve(path) }; },
    contains(parent, child) { const path = relative(parent.targetKey, child.targetKey); return path === '' || (!path.startsWith('..') && !path.startsWith('/')); },
    async stat(target) { return entries.get(target.targetKey); },
    async readText(target) { return entries.get(target.targetKey).content; },
    async listDir(target) { return [...entries].filter(([path]) => path !== target.targetKey && dirname(path) === target.targetKey).map(([path, entry]) => ({ name: path.slice(target.targetKey.length + 1), type: entry.type })); },
    async writeText(target, content, guard, signal, receivedPolicy) {
      signal?.throwIfAborted();
      assert.equal(receivedPolicy, policy);
      const current = entries.get(target.targetKey);
      if ((guard.kind === 'createIfAbsent' && current) || (guard.kind === 'replaceIfVersion' && current?.version !== guard.version)) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      let parent = dirname(target.targetKey);
      while (!entries.has(parent)) { entries.set(parent, { type: 'directory', version: `d${++version}` }); if (parent === '/') break; parent = dirname(parent); }
      const next = { type: 'file', version: `v${++version}`, content };
      entries.set(target.targetKey, next);
      writes.push({ path: target.targetKey, guard, policy: receivedPolicy });
      return { version: next.version };
    },
  } };
  return { ctx, entries, writes, policy };
}

test('Host files use guarded writes and session policy, and fence configured paths', async () => {
  const { ctx, writes } = fileContext();
  const files = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } });
  await files.mkdir('/state/jobs');
  assert.deepEqual(await files.list('/state/jobs'), []);
  const version = await files.write('/state/jobs/a.json', '{}', null);
  assert.deepEqual(await files.read('/state/jobs/a.json'), { content: '{}', version });
  await files.write('/state/jobs/a.json', '{"state":"pending"}', version);
  assert.deepEqual(writes.map(w => w.guard), [{ kind: 'createIfAbsent' }, { kind: 'replaceIfVersion', version }]);
  await assert.rejects(files.write('/outside/file', 'not allowed', null), /outside the configured roots/);
  await assert.rejects(files.write('/memory/../outside/file', 'not allowed', null), /outside the configured roots/);
  await assert.rejects(files.remove('/state/jobs/a.json'), /does not expose removal/);
  assert.throws(() => createHostFiles({ fs: ctx.fs }, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } }), /sandbox policy unavailable/);
  const resolveOriginal = ctx.fs.resolve;
  ctx.fs.resolve = async (...args) => {
    const result = await resolveOriginal(...args);
    return args[0] === '/memory/link.md' ? { ...result, targetKey: '/outside/real.md' } : result;
  };
  await assert.rejects(files.read('/memory/link.md'), /resolves outside/);
});

test('Host stat distinguishes absent directories from empty directories without returning content', async () => {
  const { ctx } = fileContext();
  const files = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } });
  assert.deepEqual(await files.stat('/memory'), { type: 'directory', version: 'root' });
  assert.equal(await files.stat('/memory/daily'), null);
  const version = await files.write('/memory/daily/2026-10-26.md', 'synthetic source', null);
  assert.equal((await files.stat('/memory/daily')).type, 'directory');
  assert.deepEqual(await files.stat('/memory/daily/2026-10-26.md'), { type: 'file', version });
  await assert.rejects(files.stat('/outside'), /outside the configured roots/);
});

test('two adapters serialize by memory root and retain matched release markers', async () => {
  const { ctx, entries } = fileContext();
  const a = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } });
  const b = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/another-state' } });
  let active = 0;
  let maximum = 0;
  const operation = async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; };
  await Promise.all([a.withLock('session-a', operation), b.withLock('session-b', operation)]);
  assert.equal(maximum, 1);
  for (const generation of ['000000000001', '000000000002']) {
    const acquired = JSON.parse(entries.get(`/memory/.dsh-dream-locks/${generation}.acquire.json`).content);
    const released = JSON.parse(entries.get(`/memory/.dsh-dream-locks/${generation}.released.json`).content);
    assert.equal(acquired.ownerToken, released.ownerToken);
  }
});

test('generation locks can contain state transactions without reentering the same lock', async () => {
  const { ctx, entries } = fileContext();
  const files = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } });
  const order = [];
  await files.withGenerationLock(async () => {
    order.push('generation');
    await files.withLock('memory', async () => { order.push('state'); });
  });
  assert.deepEqual(order, ['generation', 'state']);
  assert.ok(entries.has('/memory/.dsh-dream-generation-locks/000000000001.released.json'));
  assert.ok(entries.has('/memory/.dsh-dream-locks/000000000001.released.json'));
});

test('persisted live owners block acquisition and exited owners can be recovered', async () => {
  const { ctx, entries } = fileContext();
  const files = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' } });
  const path = '/memory/.dsh-dream-locks/000000000001.acquire.json';
  await files.write(path, JSON.stringify({ ownerToken: 'owner-before-restart', pid: process.pid }), null);
  await assert.rejects(files.withLock('key', () => assert.fail('must not enter')), error => error.code === 'LOCKED');
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(exited.status, 0);
  const current = await files.read(path);
  await files.write(path, JSON.stringify({ ownerToken: 'owner-before-restart', pid: exited.pid }), current.version);
  let entered = false;
  await files.withLock('key', () => { entered = true; });
  assert.equal(entered, true);
  assert.equal(JSON.parse(entries.get('/memory/.dsh-dream-locks/000000000001.released.json').content).abandoned, true);
});

test('independent module queues cannot both acquire the same persisted generation', async () => {
  const { createHostFiles: independentFiles } = await import('../dist/harness/files.js?independent-lock-queue');
  const { ctx } = fileContext();
  const options = { roots: { memoryRoot: '/memory', stateRoot: '/state' } };
  const left = createHostFiles(ctx, makeAgent(), options);
  const right = independentFiles(ctx, makeAgent(), options);
  let entered = 0;
  const operation = async () => { entered++; await new Promise(resolve => setImmediate(resolve)); };
  const results = await Promise.allSettled([left.withLock('left', operation), right.withLock('right', operation)]);
  assert.equal(entered, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'LOCKED');
});

test('lock release still runs when the operation is cancelled', async () => {
  const { ctx, entries } = fileContext();
  const controller = new AbortController();
  const files = createHostFiles(ctx, makeAgent(), { roots: { memoryRoot: '/memory', stateRoot: '/state' }, signal: controller.signal });
  await assert.rejects(files.withLock('key', () => { controller.abort(new Error('cancel operation')); throw controller.signal.reason; }), /cancel operation/);
  assert.ok(entries.has('/memory/.dsh-dream-locks/000000000001.released.json'));
});
