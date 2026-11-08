import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettledCleanup } from '../dist/harness/lifecycle.js';
import { apply } from '../dist/index.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flattenErrors = error => error instanceof AggregateError ? error.errors.flatMap(flattenErrors) : [error];

test('cleanup starts all actions despite synchronous throws and waits for every rejected or pending action', async () => {
  const calls = [], controller = deferred(), narratives = deferred();
  const stopError = new Error('stop failed'), engineError = new Error('engine flush failed'), narrativeError = new Error('narrative flush failed');
  const cleanup = createSettledCleanup([
    () => { calls.push('stop'); throw stopError; },
    () => { calls.push('controller'); return controller.promise; },
    () => { calls.push('engine'); return Promise.reject(engineError); },
    () => { calls.push('narratives'); return narratives.promise; },
    () => { calls.push('last-disposer'); },
  ]);
  const pending = cleanup();
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, error => error instanceof AggregateError && assert.deepEqual(error.errors, [stopError, engineError, narrativeError]) === undefined);
  assert.deepEqual(calls, ['stop', 'controller', 'engine', 'narratives', 'last-disposer']);
  await tick(); assert.equal(settled, false);
  narratives.reject(narrativeError);
  await tick(); assert.equal(settled, false);
  controller.resolve();
  await rejected;
  assert.equal(settled, true);
});

test('cleanup is idempotent during reentrancy, pending drain and after failure', async () => {
  const gate = deferred(); const failure = new Error('one failure'); let calls = 0, nested;
  let cleanup;
  cleanup = createSettledCleanup([
    () => { calls++; nested = cleanup(); },
    () => { calls++; return gate.promise; },
    () => { calls++; throw failure; },
  ]);
  const first = cleanup();
  assert.equal(nested, first); assert.equal(cleanup(), first); assert.equal(calls, 3);
  const rejected = assert.rejects(first, error => error instanceof AggregateError && error.errors[0] === failure);
  gate.resolve(); await rejected;
  assert.equal(cleanup(), first); assert.equal(calls, 3);
});

test('cleanup also drains asynchronous stop actions and memoizes success', async () => {
  const gate = deferred(); const order = [];
  const cleanup = createSettledCleanup([() => { order.push('stop'); return gate.promise; }, () => { order.push('flush'); }]);
  let settled = false; const pending = cleanup(); void pending.then(() => { settled = true; });
  assert.deepEqual(order, ['stop', 'flush']);
  await tick(); assert.equal(settled, false); gate.resolve(); await pending;
  assert.equal(cleanup(), pending);
});

function fixture(t, hooks = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-08T12:00:00Z') });
  const listeners = new Map(), agents = new Map(); const removed = [], logged = [], tools = new Map();
  const config = { sessionId: 'synthetic-lifecycle', memoryRoot: '/synthetic/lifecycle-memory', stateRoot: '/synthetic/lifecycle-state', start: '05:00', end: '07:00', timeZone: 'UTC' };
  const ctx = {
    agents: { get: id => agents.get(id) }, effect: work => work(),
    on(name, callback) {
      const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set);
      return () => { set.delete(callback); removed.push(name); hooks.removeListener?.(name); };
    },
    fs: {
      async resolve(path) { return { targetKey: path }; },
      async stat() { return undefined; },
      contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(parent.targetKey + '/'); },
      readText() { assert.fail('no synthetic memory contents needed'); },
      async listDir() { return []; }, writeText() { assert.fail('no writes during lifecycle regression'); },
    },
    tools: { register() { assert.fail('no root tool registration'); } },
    llm: { prepareCall() { assert.fail('no model calls'); } },
    compaction: { compactNow() { assert.fail('no compaction'); } },
    logger: { error(error) { logged.push(error); hooks.log?.(error); } },
  };
  const agent = { id: config.sessionId, session: { id: config.sessionId }, options: { provider: 'synthetic', model: 'synthetic-model' },
    async whenIdle() {}, followup() { assert.fail('no followup'); } };
  agent.ctx = Object.assign(Object.create(ctx), { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); } } });
  agents.set(agent.id, agent);
  return { ctx, config, agent, listeners, removed, logged, tools,
    emit(name, payload) { for (const callback of [...listeners.get(name) ?? []]) callback(payload); },
  };
}

test('plugin retirement reports synchronous observer/engine errors only after controller drainage and still unregisters tools', async t => {
  const f = fixture(t), gate = deferred(); let engine, unbound = 0, flushed = 0;
  const observerError = new Error('synthetic unbind failure'), flushError = new Error('synthetic sync flush failure');
  const dispose = apply(f.ctx, f.config, {
    bind(value) { engine = value; engine.resume = () => gate.promise; engine.flush = () => { flushed++; throw flushError; }; },
    unbind() { unbound++; throw observerError; },
  });
  await tick();
  let settled = false;
  const closing = dispose(); void closing.then(() => { settled = true; });
  assert.equal(dispose(), closing);
  assert.equal(unbound, 1); assert.equal(flushed, 1); assert.equal(f.tools.size, 0);
  await tick(); assert.equal(settled, false); assert.deepEqual(f.logged, []);
  gate.resolve(); await closing;
  assert.equal(f.logged.length, 1);
  assert.deepEqual(flattenErrors(f.logged[0]), [observerError, flushError]);
  assert.equal(dispose(), closing); assert.equal(unbound, 1);
  assert.ok(engine); assert.ok([...f.listeners.values()].every(set => set.size === 0));
});

test('plugin disposal cannot finish early when one instance logger throws and another instance still drains', async t => {
  const logFailure = new Error('synthetic logger failure'); const f = fixture(t, { log() { throw logFailure; } });
  const old = deferred(), current = deferred(); let binds = 0;
  const dispose = apply(f.ctx, f.config, { bind(engine) {
    engine.resume = async () => {};
    engine.flush = () => ++binds === 1 ? old.promise : current.promise;
  } });
  await tick();
  f.emit('agent/disposed', { agent: f.agent });
  f.emit('agent/created', { agent: f.agent });
  await tick();
  const closing = dispose(); let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(closing, error => flattenErrors(error).includes(logFailure));
  old.reject(new Error('old instance failed'));
  await tick(); assert.equal(settled, false);
  current.resolve(); await rejected;
  assert.equal(f.logged.length, 1); assert.equal(f.tools.size, 0);
});

test('root listener disposal errors do not prevent other listeners, instance cleanup, or pending flush', async t => {
  const gate = deferred(); const failure = new Error('synthetic listener removal');
  const f = fixture(t, { removeListener(name) { if (name === 'agent/created') throw failure; } });
  const dispose = apply(f.ctx, f.config, { bind(engine) { engine.resume = async () => {}; engine.flush = () => gate.promise; } });
  await tick(); const closing = dispose(); let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(closing, error => flattenErrors(error).includes(failure));
  assert.ok(f.removed.includes('agent/disposed')); assert.equal(f.tools.size, 0);
  await tick(); assert.equal(settled, false);
  gate.resolve(); await rejected;
  assert.ok([...f.listeners.values()].every(set => set.size === 0));
});
