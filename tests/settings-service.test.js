import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsService } from '../dist/settings/service.js';
import { Config, configurationIssues, resolvedDraft, validateSettingsConfiguration } from '../dist/settings/configuration.js';
import { SettingsFailure } from '../dist/settings/contracts.js';

// Every path is inert synthetic configuration, never a filesystem fixture.
const complete = (extra = {}) => ({ sessionId: 'explicit-target', memoryRoot: '/synthetic/dream-memory', stateRoot: '/synthetic/dream-state', ...extra });
function fixture({ initial = { enabled: false, configuration: {} }, inherited = {}, mounted = true,
  hasEditor = true, hasEntry = true, entryId = 'dsh-dream-configuration', fallbackId = false } = {}) {
  const reads = [], edits = [], forbidden = [], lookedUpAgents = [];
  const noIO = name => () => { forbidden.push(name); throw new Error(`Unexpected test I/O: ${name}`); };
  const chosen = fallbackId
    ? { id: entryId, options: { config: structuredClone(initial) } }
    : { id: 'loader-resolved-id', options: { id: entryId, name: 'dsh-dream/configuration', config: structuredClone(initial) } };
  const unrelated = { id: 'other-entry', options: { id: 'unrelated', config: { enabled: true, configuration: complete({ sessionId: 'not-the-target' }) } } };
  const state = { inherited: structuredClone(inherited), beforeEdit: undefined, publish: true };
  let service, dispose;
  const editor = {
    entries() { reads.push('entries'); return hasEntry ? [unrelated, chosen] : [unrelated]; },
    configuration() { reads.push('configuration'); return [
      { entry: unrelated, inherited: { configuration: complete({ sessionId: 'unrelated-inherited' }) }, override: {} },
      { entry: chosen, inherited: state.inherited, override: chosen.options.config },
    ]; },
    async edit(entry, change) {
      assert.equal(entry, chosen, 'must persist through the exact Loader entry object');
      edits.push({ entry });
      await state.beforeEdit?.(chosen, state);
      const candidate = change(chosen.options.config, state.inherited);
      edits.at(-1).candidate = structuredClone(candidate);
      chosen.options.config = structuredClone(candidate);
      // Simulate Loader publishing the committed disabled owner configuration;
      // never execute an enabled run in this unit test fixture.
      assert.equal(candidate.enabled, false, 'tests never mount an enabled business');
      if (state.publish) {
        await dispose?.();
        dispose = service.mount(ctx, validateSettingsConfiguration(candidate));
      }
    },
  };
  const ctx = {
    get(name) {
      reads.push(`get:${name}`);
      if (name === 'configEditor') return hasEditor ? editor : undefined;
      if (name === 'currentSession' || name === 'session') return { id: 'gui-current-not-selected' };
      return undefined;
    },
    agents: { get(id) { lookedUpAgents.push(id); return undefined; }, list: noIO('agent-list') },
    fs: { resolve: noIO('fs.resolve'), stat: noIO('fs.stat'), readText: noIO('fs.readText'), writeText: noIO('fs.writeText') },
    llm: { prepareCall: noIO('llm.prepareCall') }, compaction: { compactNow: noIO('compaction.compactNow') },
    tools: { register: noIO('tools.register') }, on: noIO('ctx.on'), effect: noIO('ctx.effect'),
    logger: { error: noIO('logger.error') },
    session: { id: 'gui-current-not-selected' }, currentSession: { id: 'gui-current-not-selected' },
  };
  service = createSettingsService(ctx, entryId);
  if (mounted) dispose = service.mount(ctx, validateSettingsConfiguration(initial));
  return { service, ctx, state, chosen, unrelated, reads, edits, forbidden, lookedUpAgents, dispose: () => dispose?.() };
}
const code = expected => error => error instanceof SettingsFailure && error.code === expected;

test('unconfigured disabled settings read without filesystem model registry or automatic session selection', async () => {
  const f = fixture();
  const view = await f.service.read();
  assert.equal(view.enabled, false);
  assert.equal(view.configured, false);
  assert.equal(view.writable, true);
  assert.equal(view.status.state, 'unconfigured');
  assert.match(view.revision, /^[a-f0-9]{64}$/);
  assert.equal(typeof view.hostTimeZone, 'string');
  assert.ok(view.hostTimeZone.length > 0);
  assert.equal(view.config.sessionId, undefined);
  assert.equal(view.config.memoryRoot, undefined);
  assert.equal(view.config.stateRoot, undefined);
  assert.equal(view.defaults.sessionId, undefined);
  assert.equal(view.inherited.sessionId, undefined);
  assert.ok(view.issues.length > 0);
  assert.deepEqual(f.lookedUpAgents, []);
  assert.deepEqual(f.forbidden, []);
  assert.ok(f.reads.every(read => ['entries', 'configuration', 'get:configEditor'].includes(read)));
  await f.dispose();
});

test('complete but disabled owner remains inert and exposes independent detached snapshots', async () => {
  const f = fixture({ initial: { enabled: false, configuration: complete({ reinforcementBoost: 0, recallHistoryDays: 0, singleRun: false }) } });
  const first = await f.service.read();
  assert.equal(first.configured, true);
  assert.deepEqual(first.issues, []);
  assert.equal(first.status.state, 'disabled');
  assert.equal(first.config.sessionId, 'explicit-target');
  assert.equal(first.config.reinforcementBoost, 0);
  assert.equal(first.config.recallHistoryDays, 0);
  assert.equal(first.config.singleRun, false);
  first.config.sourceSessionIds.push('must-not-persist'); first.defaults.start = '01:00'; first.inherited.end = '02:00';
  const second = await f.service.read();
  assert.deepEqual(second.config.sourceSessionIds, []);
  assert.equal(second.defaults.start, '05:00');
  assert.equal(second.inherited.end, '07:00');
  assert.deepEqual(f.lookedUpAgents, []);
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('settings configuration rejects unknown and dangerous supplied fields without silently enabling', () => {
  for (const value of [null, [], { enabled: true }, { enabled: 'false' }, { enabled: 0 }, { configuration: [] },
    { enabled: false, extra: true }, { configuration: { model: 'not-a-setting' } },
    { configuration: { memoryRoot: 'relative' } }, { configuration: { personaPath: '../persona' } },
    { configuration: complete({ stateRoot: '/synthetic/dream-memory' }) },
    { configuration: complete({ sourceSessionIds: ['duplicate', 'duplicate'] }) },
    { configuration: complete({ dreamContextRefs: [{ sessionId: 'not-authorized', seq: 1 }] }) },
    { configuration: complete({ originalSources: [{ sourceId: 's', ref: { sessionId: 'not-authorized', seq: 1, blockIndex: 0, quote: 'q' } }] }) },
    { configuration: { maxSourceBytes: 0 } }, { configuration: { reinforcementBoost: -1 } },
    JSON.parse('{"configuration":{"__proto__":{"enabled":true}}}'),
    Object.assign(Object.create({ enabled: true }), { configuration: {} }),
  ]) assert.throws(() => validateSettingsConfiguration(value), TypeError);
});

test('incomplete disabled configuration preserves meaningful false and zero and never persists sentinels', () => {
  const value = { enabled: false, configuration: { sessionId: '', memoryRoot: '', stateRoot: '', personaPath: undefined,
    dreamMood: undefined, reinforcementBoost: 0, recallHistoryDays: 0, singleRun: false, dreamMode: 'off' } };
  const checked = validateSettingsConfiguration(value);
  assert.deepEqual(checked, { enabled: false, configuration: { reinforcementBoost: 0, recallHistoryDays: 0, singleRun: false, dreamMode: 'off' } });
  assert.equal(value.configuration.sessionId, '');
  assert.equal(JSON.stringify(checked).includes('__unconfigured__'), false);
  assert.deepEqual(validateSettingsConfiguration({}), { enabled: false, configuration: {} });
  const withLists = { enabled: false, configuration: complete({ sourceSessionIds: ['authorized'] }) };
  const detached = validateSettingsConfiguration(withLists);
  withLists.configuration.sourceSessionIds.push('later');
  assert.deepEqual(detached.configuration.sourceSessionIds, ['authorized']);
});

test('Standard Schema and draft issue helpers preserve strict runtime validation', () => {
  const okay = Config['~standard'].validate({ configuration: { reinforcementBoost: 0 } });
  assert.deepEqual(okay.value, { enabled: false, configuration: { reinforcementBoost: 0 } });
  const invalid = Config['~standard'].validate({ configuration: { unexpected: true } });
  assert.ok(invalid.issues[0].message.includes('unexpected'));
  assert.equal(invalid.value, undefined);
  assert.equal(configurationIssues(resolvedDraft({}))[0].field, 'sessionId');
  assert.deepEqual(configurationIssues(resolvedDraft(complete())), []);
  assert.equal(resolvedDraft({ singleRun: false, recallHistoryDays: 0 }).recallHistoryDays, 0);
});

test('read selects exact owner metadata and preserves inherited defaults separately from current values', async () => {
  const f = fixture({ entryId: 'explicit-owner', fallbackId: true,
    initial: { enabled: false, configuration: complete({ start: '01:00' }) },
    inherited: { enabled: false, configuration: { start: '03:00', reinforcementBoost: 0, recallHistoryDays: 0 } } });
  const view = await f.service.read();
  assert.equal(view.config.start, '01:00');
  assert.equal(view.inherited.start, '03:00');
  assert.equal(view.inherited.reinforcementBoost, 0);
  assert.equal(view.inherited.recallHistoryDays, 0);
  assert.equal(view.defaults.start, '05:00');
  assert.notEqual(view.config.sessionId, f.unrelated.options.config.configuration.sessionId);
  f.state.inherited.configuration.start = '04:00';
  assert.notEqual((await f.service.read()).revision, view.revision, 'inherited metadata participates in revision');
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('saving disabled draft uses exact editor callback and never invokes model or preflight filesystem', async () => {
  const f = fixture();
  const before = await f.service.read();
  const config = complete({ singleRun: false, reinforcementBoost: 0, recallHistoryDays: 0 });
  const after = await f.service.save({ revision: before.revision, config, enabled: false });
  assert.equal(f.edits.length, 1);
  assert.equal(f.edits[0].entry, f.chosen);
  assert.deepEqual(f.edits[0].candidate, { enabled: false, configuration: config });
  assert.equal(after.enabled, false);
  assert.equal(after.configured, true);
  assert.equal(after.status.state, 'disabled');
  assert.notEqual(after.revision, before.revision);
  config.sessionId = 'mutated-request';
  assert.equal((await f.service.read()).config.sessionId, 'explicit-target');
  assert.deepEqual(f.lookedUpAgents, []);
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('explicit branch model saves validate catalog before editor while follow retains inert behavior', async () => {
  const f = fixture();
  f.ctx.llm.listProviders = () => [{ id: 'catalog', name: 'Catalog' }];
  f.ctx.llm.listModels = async () => [{ provider: 'catalog', id: 'chosen', name: 'Chosen' }];
  f.ctx.llm.resolveModelInfo = async () => ({ provider: 'catalog', id: 'chosen', name: 'Chosen', reasoning: { efforts: [{ id: 'supported', name: 'Supported' }] } });
  const before = await f.service.read();
  await assert.rejects(f.service.save({ revision: before.revision, config: complete({ memoryModel: { provider: 'catalog', model: 'chosen', reasoningEffort: 'not-supported' } }), enabled: false }), code('INVALID_CONFIGURATION'));
  assert.equal(f.edits.length, 0);
  const config = complete({ memoryModel: { provider: 'catalog', model: 'chosen', reasoningEffort: 'supported' }, reviewModel: { provider: 'catalog', model: 'chosen' } });
  const after = await f.service.save({ revision: before.revision, config, enabled: false });
  assert.deepEqual(after.config.memoryModel, config.memoryModel); assert.equal(f.edits.length, 1);
  const previous = after.revision;
  f.ctx.llm.listProviders = () => { throw Error('directory temporarily offline'); };
  const disabledAgain = await f.service.save({ revision: previous, config: { ...config, start: '04:30' }, enabled: false });
  assert.deepEqual(disabledAgain.config.memoryModel, config.memoryModel, 'unchanged stored choice remains removable/editable during provider outage');
  const removed = { ...disabledAgain.config }; delete removed.memoryModel; delete removed.reviewModel;
  await f.service.save({ revision: disabledAgain.revision, config: removed, enabled: false, confirmScope: true });
  assert.deepEqual(f.forbidden, []); await f.dispose();
});

test('disabled retarget rechecks unchanged custom models in the new target service realm', async () => {
  const initial = { enabled: false, configuration: complete({ memoryModel: { provider: 'old-only', model: 'chosen' } }) }, f = fixture({ initial });
  f.ctx.llm.listProviders = () => [];
  f.ctx.llm.listModels = async () => [];
  f.ctx.llm.resolveModelInfo = async () => { throw Error('No such model'); };
  const view = await f.service.read();
  await assert.rejects(f.service.save({ revision: view.revision, config: { ...view.config, sessionId: 'new-target' }, enabled: false, confirmScope: true }), code('INVALID_CONFIGURATION'));
  assert.equal(f.edits.length, 0); assert.deepEqual(f.forbidden, []); await f.dispose();
});

test('editor callback rechecks latest current and inherited revision instead of trusting an earlier read', async () => {
  for (const mutate of [
    chosen => { chosen.options.config = { enabled: false, configuration: { start: '02:00' } }; },
    (_chosen, state) => { state.inherited = { configuration: { start: '04:00' } }; },
  ]) {
    const f = fixture();
    const view = await f.service.read();
    f.state.beforeEdit = mutate;
    await assert.rejects(f.service.save({ revision: view.revision, config: complete(), enabled: false }), code('SETTINGS_CONFLICT'));
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].candidate, undefined, 'conflict prevents producing a replacement config');
    assert.deepEqual(f.forbidden, []);
    await f.dispose();
  }
});

test('missing or inactive settings owner stays read-only and refuses edits', async () => {
  for (const setup of [{ hasEditor: false }, { hasEntry: false }, { mounted: false }]) {
    const f = fixture(setup);
    const view = await f.service.read();
    assert.equal(view.writable, false);
    await assert.rejects(f.service.save({ revision: view.revision, config: {}, enabled: false }), code('UNAVAILABLE'));
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.forbidden, []);
    await f.dispose();
  }
  const f = fixture();
  const before = await f.service.read();
  await f.dispose();
  const after = await f.service.read();
  assert.equal(after.writable, false);
  assert.notEqual(after.revision, before.revision);
});

test('enable and target expansion require literal explicit confirmation before preflight or persistence', async () => {
  for (const confirmEnable of [undefined, false, 'true', 1]) {
    const f = fixture();
    const view = await f.service.read();
    await assert.rejects(f.service.save({ revision: view.revision, config: complete(), enabled: true, confirmEnable }), code(confirmEnable === undefined ? 'CONFIRM_ENABLE' : 'INVALID_REQUEST'));
    assert.deepEqual(f.lookedUpAgents, []);
    assert.deepEqual(f.edits, []);
    assert.deepEqual(f.forbidden, []);
    await f.dispose();
  }
  const f = fixture({ initial: { enabled: false, configuration: complete() } });
  const view = await f.service.read();
  await assert.rejects(f.service.save({ revision: view.revision, config: complete({ sourceSessionIds: ['expanded-source'] }), enabled: false }), code('CONFIRM_SCOPE'));
  assert.deepEqual(f.edits, []);
  await f.service.save({ revision: view.revision, config: complete({ sourceSessionIds: ['expanded-source'] }), enabled: false, confirmScope: true });
  assert.deepEqual((await f.service.read()).config.sourceSessionIds, ['expanded-source']);
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('confirmed enable still fails unavailable explicit target preflight without selecting GUI current session', async () => {
  const f = fixture();
  const view = await f.service.read();
  const config = complete();
  await assert.rejects(f.service.save({ revision: view.revision, config, enabled: true, confirmEnable: true }), error => {
    assert.ok(code('PREFLIGHT_FAILED')(error));
    assert.equal(error.details.canEnable, false);
    assert.deepEqual(error.details.checks.map(check => [check.id, check.state]), [['configuration', 'ready'], ['session', 'unavailable']]);
    return true;
  });
  assert.deepEqual(f.lookedUpAgents, ['explicit-target']);
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.forbidden, []);
  assert.equal((await f.service.read()).enabled, false);
  await f.dispose();
});

test('preflight validates only supplied configuration and never fills missing target from context', async () => {
  const f = fixture();
  const invalid = await f.service.preflight({ config: { memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' } });
  assert.equal(invalid.canEnable, false);
  assert.deepEqual(invalid.checks.map(check => check.id), ['configuration']);
  assert.equal(invalid.checks[0].state, 'invalid');
  assert.deepEqual(f.lookedUpAgents, []);
  const absent = await f.service.preflight({ config: complete({ sessionId: 'user-selected' }) });
  assert.equal(absent.canEnable, false);
  assert.deepEqual(f.lookedUpAgents, ['user-selected']);
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('save rejects unknown action or model fields and does not grant proposal approval', async () => {
  const f = fixture();
  const view = await f.service.read();
  for (const extra of [{ decision: 'accept' }, { model: 'chosen-by-form' }, { prompt: 'do it' }, { execute: true }]) {
    await assert.rejects(f.service.save({ revision: view.revision, config: {}, enabled: false, ...extra }), code('INVALID_REQUEST'));
  }
  await assert.rejects(f.service.save({ revision: view.revision, config: { tools: [] }, enabled: false }), /Unknown configuration field/);
  await assert.rejects(f.service.save({ revision: '', config: {}, enabled: false }), code('INVALID_REQUEST'));
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.forbidden, []);
  await f.dispose();
});

test('settings first read includes only saved target and source labels without a search or memory access', async () => {
  const f = fixture({ initial: { enabled: false, configuration: complete({ sourceSessionIds: ['saved-source'] }) } });
  const calls = [], originalGet = f.ctx.get;
  f.ctx.get = name => name === 'sessions' ? { get(id) { calls.push(id); return { header: { id, cwd: '/synthetic/project' } }; } }
    : name === 'sessionProjections' ? { snapshot(session, keys) { assert.deepEqual(keys, ['title']); return { values: { title: 'Label for ' + session.header.id } }; } } : originalGet(name);
  const view = await f.service.read();
  assert.deepEqual(view.sessionOptions.map(item => [item.id, item.title]), [['explicit-target', 'Label for explicit-target'], ['saved-source', 'Label for saved-source']]);
  assert.ok(calls.every(id => ['explicit-target', 'saved-source'].includes(id))); assert.deepEqual(f.forbidden, []); assert.deepEqual(f.edits, []);
  await f.dispose();
});

test('missing title metadata cannot break settings or persist a label, but caller cancellation propagates', async () => {
  const f = fixture({ initial: { enabled: false, configuration: complete() } }), originalGet = f.ctx.get;
  f.ctx.get = name => name === 'sessionPersistence' ? { async stat() { throw Error('Metadata backend unavailable'); } } : originalGet(name);
  const view = await f.service.read(); assert.deepEqual(view.sessionOptions, [{ id: 'explicit-target', title: 'explicit-target', live: false }]);
  assert.equal(view.enabled, false); assert.equal(view.configured, true); assert.deepEqual(f.edits, []);
  const stop = new AbortController(); stop.abort(); await assert.rejects(f.service.read(stop.signal));
  await f.dispose();
});

test('SettingsFailure carries machine-readable code details and Error identity', () => {
  const details = { canEnable: false };
  const failure = new SettingsFailure('PREFLIGHT_FAILED', 'Synthetic failure', details);
  assert.ok(failure instanceof Error);
  assert.equal(failure.name, 'SettingsFailure');
  assert.equal(failure.code, 'PREFLIGHT_FAILED');
  assert.equal(failure.message, 'Synthetic failure');
  assert.equal(failure.details, details);
});
