import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { buildCleanReviewPayload, cleanReviewDigest } from '../dist/review/isolation.js';
import { apply, inject, Config } from '../dist/index.js';
import { createController } from '../dist/scheduler/controller.js';

const config = { sessionId: 'wanted', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state',
  start: '05:00', end: '07:00', timeZone: 'UTC' };

function controlledClock(initial) {
  let time = new Date(initial);
  let id = 0;
  const timers = new Map();
  return {
    now: () => new Date(time),
    set: value => { time = new Date(value); },
    setTimer: (callback, delay) => { const key = ++id; timers.set(key, { callback, delay }); return key; },
    clearTimer: key => timers.delete(key),
    timers,
  };
}

function fakeEngine(overrides = {}) {
  const calls = { resume: 0, dream: [], submit: [] };
  const engine = {
    async resume() { calls.resume++; },
    async status() { return { jobs: [] }; },
    async dream(args) { calls.dream.push(args); return { skipped: true }; },
    submit(args) { calls.submit.push(args); return { queued: true }; },
    ...overrides,
  };
  return { engine, calls };
}

test('controller resumes once, never generates in daytime, and advances committed work', async () => {
  const clock = controlledClock('2026-10-26T12:00:00Z');
  const { engine, calls } = fakeEngine({ async status() { return { jobs: [{ jobId: 'committed', state: 'applied' }, { jobId: 'pending', state: 'awaiting_review' }] }; } });
  const notices = [];
  const controller = createController({ config, engine, host: { notify: text => notices.push(text) }, ...clock });
  controller.start();
  controller.start();
  await controller.flush();
  await controller.tick();
  assert.equal(calls.resume, 1);
  assert.equal(calls.dream.length, 0);
  assert.deepEqual(calls.submit, [{ jobId: 'committed' }, { jobId: 'committed' }]);
  assert.equal(clock.timers.size, 1);
  controller.stop();
  assert.equal(clock.timers.size, 0);
  assert.equal(notices.length, 0);
});

test('controller starts in the rest window and cancels at its end without rerunning resume', async () => {
  const clock = controlledClock('2026-10-26T04:59:45Z');
  const active = [];
  const { engine, calls } = fakeEngine({ dream({ signal }) {
    active.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const notices = [];
  const controller = createController({ config, engine, host: { notify: text => notices.push(text) }, ...clock });
  controller.start();
  await controller.flush();
  assert.equal([...clock.timers.values()][0].delay, 15000);
  assert.equal(active.length, 0);
  clock.set('2026-10-26T05:00:00Z');
  await controller.tick();
  assert.equal(active.length, 1);
  await controller.tick();
  assert.equal(active.length, 1);
  clock.set('2026-10-26T07:00:00Z');
  await controller.tick();
  await controller.flush();
  assert.equal(active[0].aborted, true);
  assert.equal(active[0].reason.code, 'REST_WINDOW_ENDED');
  assert.equal(calls.resume, 1);
  assert.equal(notices.length, 0);
  controller.stop();
});

test('controller reports an unhandled recurring error once and does not duplicate engine reports', async () => {
  const clock = controlledClock('2026-10-26T05:30:00Z');
  let error = new Error('Missing configured source');
  const { engine } = fakeEngine({ async dream() { throw error; } });
  const notices = [];
  const controller = createController({ config, engine, host: { notify: text => notices.push(text) }, ...clock });
  controller.start();
  await controller.flush();
  await controller.tick();
  await controller.flush();
  assert.equal(notices.length, 1);
  error = Object.assign(new Error('Already reported by engine'), { dreamHandled: true });
  await controller.tick();
  await controller.flush();
  assert.equal(notices.length, 1);
  controller.stop();
});

test('controller never places private validation quotes in fallback attention notifications', async () => {
  const clock = controlledClock('2026-10-26T05:30:00Z'), notices = [];
  const { engine } = fakeEngine({ async dream() { throw Object.assign(new Error('SYNTHETIC_QUOTE_PRIVATE nearest=SYNTHETIC_SOURCE_PRIVATE'), { code: 'GENERATION_VALIDATION_FAILED' }); } });
  const controller = createController({ config, engine, host: { notify: text => notices.push(text) }, ...clock });
  controller.start(); await controller.flush(); controller.stop();
  assert.equal(notices.length, 1); assert.doesNotMatch(notices[0], /SYNTHETIC_.*PRIVATE/); assert.match(notices[0], /任务状态/);
});

test('stopping before startup work runs leaves no recovery task or timer', async () => {
  const clock = controlledClock('2026-10-26T05:30:00Z');
  const { engine, calls } = fakeEngine();
  const controller = createController({ config, engine, host: { notify() { assert.fail('no notification after stop'); } }, ...clock });
  controller.start();
  controller.stop();
  await controller.flush();
  assert.equal(calls.resume, 0);
  assert.equal(calls.dream.length, 0);
  assert.equal(clock.timers.size, 0);
});

function fakeContext() {
  const listeners = new Map();
  const agents = new Map();
  let fsCalls = 0;
  const ctx = {
    agents: { get: id => agents.get(id) },
    effect: execute => execute(),
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
      return () => listeners.get(name).delete(listener);
    },
    fs: {
      resolve: async path => ({ targetKey: path, displayPath: path }),
      stat: async () => { fsCalls++; return undefined; },
      contains: (parent, child) => child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`),
      readText() { assert.fail('no memory should be read in this lifecycle test'); },
      listDir: async () => [],
      writeText() { assert.fail('no memory should be written in this lifecycle test'); },
    },
    tools: { register() { assert.fail('Dream tools must register on the target agent context, not root'); } },
    llm: { prepareCall() { assert.fail('no model call in this lifecycle test'); } },
    compaction: { compactNow() { assert.fail('no compaction in this lifecycle test'); } },
    logger: { error(error) { throw error; } },
  };
  function makeAgent(id) {
    const definitions = new Map();
    const agent = { id, session: { id }, options: { provider: 'fake', model: 'fake' },
      async whenIdle() {}, followup() { assert.fail('no notification in this lifecycle test'); } };
    agent.ctx = Object.assign(Object.create(ctx), { tools: { register(definition) {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    } } });
    return { agent, definitions };
  }
  return { ctx, agents, listeners, makeAgent,
    emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    async enterStep(agent, modelSelection, turn, step) {
      const payload = { agent, messages: [], modelSelection: Object.freeze({ ...modelSelection }), turn, step, signal: new AbortController().signal };
      const callbacks = [...listeners.get('agent/pre-step') ?? []];
      const advance = index => index < callbacks.length ? callbacks[index](payload, () => advance(index + 1)) : Promise.resolve({ kind: 'enter', messages: payload.messages });
      assert.equal((await advance(0)).kind, 'enter');
    },
    fsCalls: () => fsCalls,
  };
}

test('entry binds only the configured session and cleans up across disposal and recreation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-26T12:00:00Z') });
  const context = fakeContext();
  const other = context.makeAgent('other');
  context.agents.set('other', other.agent);
  const dispose = apply(context.ctx, config);
  assert.equal(other.definitions.size, 0);
  context.emit('agent/created', { agent: other.agent });
  assert.equal(other.definitions.size, 0);
  const first = context.makeAgent('wanted');
  context.emit('agent/created', { agent: first.agent });
  assert.equal(first.definitions.size, 9);
  context.emit('agent/created', { agent: first.agent });
  assert.equal(first.definitions.size, 9);
  context.emit('agent/disposed', { agent: first.agent });
  assert.equal(first.definitions.size, 0);
  const second = context.makeAgent('wanted');
  context.emit('agent/created', { agent: second.agent });
  assert.equal(second.definitions.size, 9);
  context.emit('agent/disposed', { agent: first.agent });
  assert.equal(second.definitions.size, 9);
  await dispose();
  await dispose();
  assert.equal(second.definitions.size, 0);
  assert.ok([...context.listeners.values()].every(set => set.size === 0));
  const before = context.fsCalls();
  t.mock.timers.tick(60000);
  await Promise.resolve();
  assert.equal(context.fsCalls(), before);
});

test('entry binds an already-active target and exposes the verified configuration contract', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-26T12:00:00Z') });
  const context = fakeContext();
  const target = context.makeAgent('wanted');
  context.agents.set('wanted', target.agent);
  const dispose = apply(context.ctx, config);
  assert.equal(target.definitions.size, 9);
  assert.deepEqual([...target.definitions.keys()].sort(), ['dream_ack_reload', 'dream_recall', 'dream_reinforcement', 'dream_reload_read', 'dream_retry', 'dream_review', 'dream_review_batch', 'dream_status', 'dream_submit']);
  assert.deepEqual(inject, ['agents', 'fs', 'llm', 'tools', 'sandboxPolicy']);
  assert.equal(Config['~standard'].validate(config).value.sessionId, 'wanted');
  assert.ok(Config['~standard'].validate({}).issues.length);
  await dispose();
});

test('agent mode exposes the compaction decision tool with bounded validated arguments', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-26T12:00:00Z') });
  const context = fakeContext();
  const target = context.makeAgent('wanted');
  context.agents.set('wanted', target.agent);
  const dispose = apply(context.ctx, { ...config, compactionMode: 'agent' });
  assert.equal(target.definitions.size, 10);
  const tool = target.definitions.get('dream_decide_compaction');
  assert.deepEqual(tool.parameters.required, ['jobId', 'transactionId', 'decision', 'reason']);
  await assert.rejects(tool.execute({ jobId: 'j', transactionId: 't', decision: 'maybe', reason: 'x' }, { agent: target.agent }), /Invalid decision/);
  await assert.rejects(tool.execute({ jobId: 'j', transactionId: 't', decision: 'skip', reason: 'x', totalTokens: 0 }, { agent: target.agent }), /Unknown argument/);
  await dispose();
});

function reviewPluginFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-26T12:00:00Z') });
  const context = fakeContext();
  const target = context.makeAgent('wanted');
  context.agents.set('wanted', target.agent);
  const options = { ...config, personaPath: '/synthetic/persona.md' };
  const scope = { scopeId: 'wanted', agentId: 'wanted', sessionId: 'wanted', memoryRootId: config.memoryRoot };
  const now = new Date().toISOString();
  const snapshot = { schemaVersion: 1, snapshotId: 'persisted-snapshot', scope, capturedAt: now, sources: [
    { sourceId: 'journal.md', path: 'journal.md', role: 'journal', content: 'Synthetic event recorded.', version: 'journal-v1', writable: false, sensitivity: 'private', protectedText: [] },
    { sourceId: 'long-term.md', path: 'long-term.md', role: 'longTerm', content: 'Initial synthetic memory.\n', version: 'memory-v1', writable: true, sensitivity: 'private', protectedText: [] },
    { sourceId: 'persona', path: 'AGENTS.md', role: 'persona', content: 'Preserve the synthetic persona.', version: 'persona-v1', writable: true, sensitivity: 'private', protectedText: ['Preserve the synthetic persona.'] },
  ] };
  const proposal = { schemaVersion: 1, proposalId: 'proposal', jobId: 'job', kind: 'fact',
    text: 'GENERATOR_TEXT_SENTINEL', reason: 'GENERATOR_REASON_SENTINEL', impact: 'GENERATOR_IMPACT_SENTINEL',
    evidence: [{ sourceId: 'journal.md', quote: 'Synthetic event recorded.' }],
    targetId: 'long-term.md', operation: 'append', before: '', after: 'Synthetic event recorded.\n' };
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, state: 'awaiting_review', proposals: [proposal],
    reviews: [], appliedProposalIds: [], createdAt: now, updatedAt: now, dreamPath: '/synthetic/state/dreams/DREAM_PATH_SENTINEL.md',
    reviewDelivery: { messageId: 'review-message', state: 'sent', at: now, sentAt: now, history: [] } };
  const entries = new Map();
  const writes = [];
  const modelCalls = [];
  let version = 0;
  function put(path, content, fileVersion = `v${++version}`) {
    let parent = dirname(path);
    while (!entries.has(parent)) {
      entries.set(parent, { type: 'directory', version: 'directory' });
      if (parent === '/') break;
      parent = dirname(parent);
    }
    entries.set(path, { type: 'file', content, version: fileVersion, size: Buffer.byteLength(content) });
  }
  const jobPath = `${config.stateRoot}/jobs/job.json`;
  put(jobPath, JSON.stringify(job));
  for (const source of snapshot.sources) put(source.role === 'persona' ? options.personaPath : `${config.memoryRoot}/${source.path}`, source.content, source.version);
  context.ctx.fs.stat = async target => entries.get(target.targetKey);
  context.ctx.fs.readText = async target => entries.get(target.targetKey).content;
  context.ctx.fs.readBytes = async (target, signal, maxBytes) => {
    signal?.throwIfAborted();
    const bytes = Buffer.from(entries.get(target.targetKey).content);
    assert.ok(bytes.length <= maxBytes);
    return bytes;
  };
  context.ctx.fs.listDir = async target => [...entries].filter(([path]) => dirname(path) === target.targetKey && path !== target.targetKey)
    .map(([path, entry]) => ({ name: path.slice(target.targetKey.length + 1), type: entry.type }));
  context.ctx.fs.writeText = async (target, content, guard, signal) => {
    signal?.throwIfAborted();
    const current = entries.get(target.targetKey);
    if ((guard.kind === 'createIfAbsent' && current) || (guard.kind === 'replaceIfVersion' && current?.version !== guard.version)) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
    put(target.targetKey, content);
    writes.push(target.targetKey);
    return { version: entries.get(target.targetKey).version };
  };
  let release;
  const idle = new Promise(resolve => { release = resolve; });
  target.agent.whenIdle = () => idle;
  const stepSelection = Object.freeze({ provider: 'selected-provider', model: 'selected-model' });
  target.agent.session.requestHeader = () => ({ config: { ...stepSelection, reasoningEffort: 'old-auto' }, adapterDefaults: { reasoningEffort: true } });
  // A pending route change is for the next step, not this accepted tool call.
  target.agent.model = { current: () => ({ provider: 'pending-provider', model: 'pending-model', reasoningEffort: 'high' }) };
  // These must never be inspected or forwarded by the plugin's clean reviewer.
  target.agent.session.messages = [{ role: 'assistant', content: 'MAIN_HISTORY_SENTINEL' }];
  let reply = () => [{ type: 'text-delta', index: 0, text: '{"decision":"accept","reason":"Independent synthetic check."}' }, { type: 'finish', reason: { kind: 'stop' } }];
  context.ctx.llm.prepareCall = async selected => {
    assert.deepEqual(selected, { provider: 'selected-provider', model: 'selected-model' });
    return { config: { provider: 'prepared-provider', model: 'prepared-model' }, async *stream(request) {
      modelCalls.push(request);
      for (const chunk of reply()) yield chunk;
    } };
  };
  const cleanupErrors = [];
  context.ctx.logger.error = error => { cleanupErrors.push(error); };
  const dispose = apply(context.ctx, options);
  t.after(async () => {
    const stopped = dispose();
    release();
    await stopped;
    const causes = error => error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
    for (const error of cleanupErrors.flatMap(causes)) assert.match(error.message, /^Dream plugin or target agent stopped$/);
  });
  let reviewStep = 0;
  return { entries, writes, modelCalls, job, jobPath, snapshot, proposal, target, put,
    setReply(value) { reply = value; },
    async review(args = {}) {
      const step = ++reviewStep;
      await context.enterStep(target.agent, stepSelection, 1, step);
      try {
        return await target.definitions.get('dream_review').execute({ jobId: 'job', proposalId: 'proposal', decision: 'review', reason: 'MAIN_REASON_SENTINEL', ...args }, { agent: target.agent });
      } finally {
        context.emit('session/event', target.agent.session, { type: 'step/end', data: { turn: 1, step } });
      }
    },
  };
}

test('Host entry always injects the fresh isolated reviewer and persists its actual route authority', async t => {
  const f = reviewPluginFixture(t);
  await assert.rejects(f.review({ decision: 'accept' }), /Invalid decision/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.modelCalls.length, 0);
  f.put(`${config.memoryRoot}/journal.md`, 'Synthetic event recorded. Fresh uncited context.', 'journal-v2');
  f.setReply(() => [{ type: 'text-delta', index: 0, text: '{"decision":"defer","reason":"Check once more."}' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const deferred = await f.review();
  f.setReply(() => [{ type: 'text-delta', index: 0, text: '{"decision":"accept","reason":"Independent synthetic check."}' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const accepted = await f.review();
  assert.equal(deferred.decision, 'defer');
  assert.equal(accepted.decision, 'accept');
  assert.equal(accepted.authority.provider, 'prepared-provider');
  assert.equal(accepted.authority.model, 'prepared-model');
  assert.notEqual(accepted.authority.callId, deferred.authority.callId);
  assert.equal(f.modelCalls.length, 2);
  const stored = JSON.parse(f.entries.get(f.jobPath).content);
  assert.equal(stored.reviews.length, 2);
  assert.deepEqual(stored.reviews.at(-1).authority, accepted.authority);
  assert.ok(stored.proposals[0].lineage.rootIds.length > 0);
  assert.equal(stored.proposals[0].lineage.independentEvents, 'unknown');
  assert.equal(accepted.authority.inputDigest, cleanReviewDigest(stored.snapshot, stored.proposals[0]));
  for (const [index, request] of f.modelCalls.entries()) {
    assert.equal(request.provider, 'prepared-provider');
    assert.equal(request.model, 'prepared-model');
    assert.equal(request.sessionId, [deferred, accepted][index].authority.callId);
    assert.notEqual(request.sessionId, 'wanted');
    assert.equal(request.messages.length, 1);
    assert.equal(request.tools, undefined);
    assert.equal(request.toolHistory, undefined);
    assert.equal(request.system, undefined);
    const serialized = JSON.stringify(request);
    for (const sentinel of ['MAIN_HISTORY_SENTINEL', 'MAIN_REASON_SENTINEL', 'GENERATOR_TEXT_SENTINEL', 'GENERATOR_REASON_SENTINEL', 'GENERATOR_IMPACT_SENTINEL', 'DREAM_PATH_SENTINEL']) assert.ok(!serialized.includes(sentinel), sentinel);
    const input = JSON.parse(request.messages[0].content[0].text.split('\nUNTRUSTED_REVIEW_INPUT_JSON\n')[1]);
    const reviewed = stored.reviews[index];
    const reviewedSnapshot = { ...stored.snapshot, ...reviewed.basis };
    assert.deepEqual(input, buildCleanReviewPayload(reviewedSnapshot, reviewed.proposalSnapshot));
    assert.equal([deferred, accepted][index].authority.inputDigest, cleanReviewDigest(reviewedSnapshot, reviewed.proposalSnapshot));
    assert.equal(input.sources.length, 3);
    assert.match(input.sources.find(source => source.role === 'journal').content, /Fresh uncited context/);
  }
  assert.equal(f.entries.get(`${config.memoryRoot}/long-term.md`).content, 'Initial synthetic memory.\n');
});

for (const failure of ['provider', 'missing finish', 'malformed decision']) test(`Host plugin clean-review ${failure} failure creates no acceptance or writes`, async t => {
  const f = reviewPluginFixture(t);
  f.setReply(() => {
    if (failure === 'provider') throw new Error('Synthetic provider failure');
    if (failure === 'missing finish') return [{ type: 'text-delta', index: 0, text: '{"decision":"accept","reason":"Incomplete."}' }];
    return [{ type: 'text-delta', index: 0, text: '{"decision":"accept","reason":"Forgery","authority":{}}' }, { type: 'finish', reason: { kind: 'stop' } }];
  });
  await assert.rejects(f.review());
  assert.equal(f.modelCalls.length, 1);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(JSON.parse(f.entries.get(f.jobPath).content), f.job);
});

test('entry reports missing required Host services and removes partially registered listeners', () => {
  const context = fakeContext();
  const target = context.makeAgent('wanted');
  context.agents.set('wanted', target.agent);
  context.ctx.llm = undefined;
  assert.throws(() => apply(context.ctx, config), /model service unavailable/);
  assert.ok([...context.listeners.values()].every(set => set.size === 0));
  assert.equal(target.definitions.size, 0);
});
