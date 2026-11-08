import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../dist/index.js';

const config = { sessionId: 'synthetic-admission', memoryRoot: '/synthetic/admission-memory', stateRoot: '/synthetic/admission-state',
  start: '05:00', end: '07:00', timeZone: 'UTC' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const listeners = new Map(), agents = new Map();
  const calls = { registered: 0, fs: 0, bound: 0, failed: [], logged: [] };
  const forbidden = () => { calls.fs++; assert.fail('preflight must block all filesystem access'); };
  const ctx = {
    agents: { get: id => agents.get(id) },
    effect: run => run(),
    on(name, callback) {
      const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set);
      return () => set.delete(callback);
    },
    tools: { register() { calls.registered++; assert.fail('preflight must block tool registration'); } },
    fs: { resolve: forbidden, stat: forbidden, contains: forbidden, readText: forbidden, listDir: forbidden, writeText: forbidden },
    llm: { prepareCall() { assert.fail('no model during admission test'); } },
    compaction: { compactNow() { assert.fail('no compaction during admission test'); } },
    logger: { error(error) { calls.logged.push(error); } },
  };
  const agent = { id: config.sessionId, session: { id: config.sessionId }, options: { provider: 'synthetic', model: 'synthetic-model' },
    ctx, whenIdle: async () => {}, followup() { assert.fail('no followup before admission'); } };
  agents.set(agent.id, agent);
  return { ctx, agent, agents, calls, listeners,
    emit(name, payload) { for (const callback of listeners.get(name) ?? []) callback(payload); },
    observer: { bind() { calls.bound++; }, failed(error) { calls.failed.push(error); } },
  };
}

// Synthetic lifecycle-only fixtures: no Host/profile, files, or real models.
test('beforeBind rejection blocks persisted startup and later creation before any runtime activation', async () => {
  const f = fixture(); const denied = new Error('Synthetic PTC preflight denied'); const checked = [];
  const dispose = apply(f.ctx, config, { ...f.observer, async beforeBind(agent) { checked.push(agent); throw denied; } });
  await tick();
  f.emit('agent/created', { agent: f.agent });
  await tick();
  assert.deepEqual(checked, [f.agent, f.agent]);
  assert.deepEqual(f.calls.failed, [denied, denied]);
  assert.deepEqual(f.calls.logged, [denied, denied]);
  assert.equal(f.calls.bound, 0); assert.equal(f.calls.registered, 0); assert.equal(f.calls.fs, 0);
  await dispose();
  assert.ok([...f.listeners.values()].every(set => set.size === 0));
});

test('pending admission cannot bind after target cancellation or plugin disposal and disposal drains it', async () => {
  for (const cause of ['agent-disposed', 'plugin-disposed']) {
    const f = fixture(); const gate = deferred(); let checks = 0;
    const dispose = apply(f.ctx, config, { ...f.observer, beforeBind(agent) { checks++; assert.equal(agent, f.agent); return gate.promise; } });
    assert.equal(checks, 1); assert.equal(f.calls.bound, 0);
    let teardown;
    let settled = false;
    if (cause === 'agent-disposed') {
      // Even if registry removal follows the event, the captured revision is stale.
      f.emit('agent/disposed', { agent: f.agent });
    } else {
      teardown = dispose().then(() => { settled = true; });
      await tick();
      assert.equal(settled, false, 'dispose must drain the admitted preflight promise');
    }
    gate.resolve();
    await tick();
    if (teardown) await teardown;
    else await dispose();
    assert.equal(f.calls.bound, 0, cause);
    assert.equal(f.calls.registered, 0, cause);
    assert.equal(f.calls.fs, 0, cause);
    assert.deepEqual(f.calls.failed, [], cause);
    assert.ok([...f.listeners.values()].every(set => set.size === 0), cause);
  }
});
