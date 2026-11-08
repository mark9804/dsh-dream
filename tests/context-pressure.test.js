import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostControl } from '../dist/harness/control.js';

// Only synthetic Host seams: no filesystem, session log or user memory access.
function fixture() {
  const route = { provider: 'synthetic-provider', model: 'synthetic-model' };
  const context = { ...route, contextWindow: 100000 };
  const measurement = { totalTokens: 12345, baseline: { kind: 'usage' }, logRevision: 42 };
  const agent = {
    id: 'synthetic-session', options: { ...route },
    session: { id: 'synthetic-session', requestContext: () => context, requestHeader: () => ({ config: { ...route } }) },
  };
  let calls = 0;
  const meter = { measure(session) { assert.equal(session, agent.session); calls++; return measurement; } };
  const ctx = { get(key) { assert.equal(key, 'tokenMeter'); return meter; } };
  Object.defineProperty(ctx, 'tokenMeter', { get() { assert.fail('must use optional get, not undeclared injection'); } });
  return { agent, ctx, context, measurement, meter, pressure: () => createHostControl(ctx, agent).contextPressure(), calls: () => calls };
}

test('context pressure returns measured tokens, route, baseline and matching window', () => {
  const f = fixture();
  assert.deepEqual(f.pressure(), {
    totalTokens: 12345, baseline: 'usage', logRevision: 42,
    provider: 'synthetic-provider', model: 'synthetic-model', contextWindow: 100000,
  });
  assert.equal(f.calls(), 1);
  // Sampling stays live instead of caching a prior request.
  f.measurement.totalTokens = 20000;
  assert.equal(f.pressure().totalTokens, 20000);
});

test('context pressure preserves all supported baseline kinds and genuine zero counts', () => {
  const f = fixture();
  for (const kind of ['none', 'estimated', 'usage']) {
    Object.assign(f.measurement, { totalTokens: 0, logRevision: 0, baseline: { kind } });
    const value = f.pressure();
    assert.equal(value.totalTokens, 0);
    assert.equal(value.logRevision, 0);
    assert.equal(value.baseline, kind);
    assert.equal(value.unavailableReason, undefined);
  }
});

test('context pressure reports missing and throwing meter without inventing a token count', () => {
  for (const get of [undefined, () => undefined, () => ({}), () => { throw new Error('private failure'); },
    () => ({ measure() { throw new Error('private failure'); } }), () => ({ measure() { return null; } })]) {
    const f = fixture();
    f.ctx.get = get;
    const value = f.pressure();
    assert.equal(value.totalTokens, undefined);
    assert.equal(value.contextWindow, 100000);
    assert.match(value.unavailableReason, /unavailable/i);
    assert.ok(!value.unavailableReason.includes('private failure'));
  }
});

test('context pressure rejects invalid external numbers independently', () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, '123', {}, true]) {
    for (const field of ['totalTokens', 'logRevision', 'contextWindow']) {
      const f = fixture();
      if (field === 'contextWindow') f.context[field] = invalid;
      else f.measurement[field] = invalid;
      const value = f.pressure();
      assert.equal(value[field], undefined, `${field}: ${String(invalid)}`);
      assert.match(value.unavailableReason, /unavailable|invalid/i);
      if (field !== 'totalTokens') assert.equal(value.totalTokens, 12345);
    }
  }
  const f = fixture();
  f.context.contextWindow = 0;
  assert.equal(f.pressure().contextWindow, undefined);
});

test('context pressure does not substitute an unknown baseline', () => {
  for (const baseline of [undefined, null, 'usage', {}, { kind: 'made-up' }]) {
    const f = fixture();
    f.measurement.baseline = baseline;
    assert.equal(f.pressure().baseline, undefined);
    assert.match(f.pressure().unavailableReason, /baseline unavailable/i);
  }
});

test('context pressure trusts matching logged route, not initial options, and rejects header mismatch', () => {
  for (const source of ['header', 'options']) {
    for (const field of ['provider', 'model']) {
      const f = fixture();
      const changed = { ...f.agent.options, [field]: 'new-route' };
      if (source === 'header') f.agent.session.requestHeader = () => ({ config: changed });
      else f.agent.options = changed;
      const value = f.pressure();
      assert.equal(value.contextWindow, source === 'header' ? undefined : 100000);
      assert.equal(value.totalTokens, 12345);
      if (source === 'header') assert.match(value.unavailableReason, /route mismatch/i);
      else assert.equal(value.unavailableReason, undefined);
      // Token measurement uses the logged header, not an invented merged route.
      assert.equal(value[field], source === 'header' ? 'new-route' : `synthetic-${field}`);
    }
  }
});

test('context pressure can use request context alone when optional routes are absent', () => {
  const f = fixture();
  delete f.agent.options;
  delete f.agent.session.requestHeader;
  assert.equal(f.pressure().contextWindow, 100000);
  assert.equal(f.pressure().unavailableReason, undefined);
});

test('context pressure reports missing, invalid and throwing request context explicitly', () => {
  for (const requestContext of [undefined, () => undefined, () => null, () => ({}),
    () => ({ provider: 7, model: 'synthetic-model', contextWindow: 100000 }),
    () => { throw new Error('private context'); }]) {
    const f = fixture();
    f.agent.session.requestContext = requestContext;
    const value = f.pressure();
    assert.equal(value.contextWindow, undefined);
    assert.equal(value.totalTokens, 12345);
    assert.match(value.unavailableReason, /unavailable/i);
    assert.ok(!value.unavailableReason.includes('private context'));
  }
});

test('context pressure fails closed on header lookup errors without losing token measurement', () => {
  const f = fixture();
  f.agent.session.requestHeader = () => { throw new Error('private header'); };
  const value = f.pressure();
  assert.equal(value.contextWindow, undefined);
  assert.equal(value.totalTokens, 12345);
  assert.match(value.unavailableReason, /route lookup failed/i);
});
