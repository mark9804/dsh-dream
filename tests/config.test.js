import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, configurationDefaults, validateConfig } from '../dist/config.js';

const minimal = { sessionId: 'synthetic-session', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state' };

test('configuration defaults follow the agreed local rest window', () => {
  const config = validateConfig(minimal);
  assert.equal(config.start, '05:00');
  assert.equal(config.end, '07:00');
  assert.equal(config.timeZone, 'local');
  assert.equal(config.compactionMode, 'auto');
  assert.equal(config.singleRun, false);
  assert.equal(config.timeoutMs, 900000);
  assert.equal(config.dreamTimeoutMs, 180000);
  assert.equal(configurationDefaults().timeoutMs, 900000);
  assert.equal(configurationDefaults().dreamTimeoutMs, 180000);
  assert.deepEqual(config.sourceSessionIds, []);
  assert.deepEqual(config.originalSources, []);
  assert.equal(config.maxOriginalBytes, 65536);
  assert.equal(config.reinforcementBoost, 0.25);
  assert.equal(config.recallHistoryDays, 90);
  assert.equal(config.maxRecallFiles, 128);
  assert.equal(config.maxRecallBytes, 1048576);
  assert.equal(config.dreamMode, 'separate');
  assert.equal(config.maxEpisodes, 32);
  assert.equal(config.maxDreamContextBytes, 16384);
  assert.deepEqual(config.dreamContextRefs, []);
  const staged = validateConfig({ ...minimal, compactionMode: 'manual', singleRun: true, start: '12:00', end: '13:00' });
  assert.equal(staged.compactionMode, 'manual');
  assert.equal(staged.singleRun, true);
  assert.equal(staged.start, '12:00');
  assert.equal(Config['~standard'].validate(minimal).value.sessionId, minimal.sessionId);
});

test('timeout defaults do not migrate explicit millisecond configurations', () => {
  const saved = { ...minimal, timeoutMs: 300000, dreamTimeoutMs: 180000 };
  const config = validateConfig(saved);
  assert.equal(config.timeoutMs, 300000);
  assert.equal(config.dreamTimeoutMs, 180000);
  assert.equal(saved.timeoutMs, 300000);
  assert.equal(saved.dreamTimeoutMs, 180000);
});

test('both timeout APIs require positive whole milliseconds within the Node timer limit', () => {
  for (const field of ['timeoutMs', 'dreamTimeoutMs']) {
    for (const value of [1, 1001, 60001, 2147483647]) {
      const candidate = { ...minimal, [field]: value };
      assert.equal(validateConfig(candidate)[field], value);
      assert.equal(Config['~standard'].validate(candidate).value[field], value);
    }
    for (const value of [0, -1, 0.5, 60000.5, NaN, Infinity, -Infinity, 2147483648, Number.MAX_SAFE_INTEGER, '900000', null, undefined, true]) {
      const candidate = { ...minimal, [field]: value };
      assert.throws(() => validateConfig(candidate), new RegExp(field));
      assert.ok(Config['~standard'].validate(candidate).issues.length);
    }
  }
});

const originalRef = { sessionId: minimal.sessionId, seq: 7, blockIndex: 0, quote: 'Synthetic original quote.' };
const binding = ref => ({ sourceId: 'journal.md', ref });

test('original bindings authorize only the target session or the explicit source allowlist', () => {
  const own = validateConfig({ ...minimal, originalSources: [binding(originalRef)] });
  assert.deepEqual(own.originalSources, [binding(originalRef)]);
  const externalRef = { ...originalRef, sessionId: 'authorized-source' };
  assert.throws(() => validateConfig({ ...minimal, originalSources: [binding(externalRef)] }), /authorized session/);
  const allowed = validateConfig({ ...minimal, sourceSessionIds: ['authorized-source'], originalSources: [binding(externalRef)] });
  assert.deepEqual(allowed.sourceSessionIds, ['authorized-source']);
  assert.deepEqual(allowed.originalSources, [binding(externalRef)]);
  assert.deepEqual(Config['~standard'].validate(allowed).value.originalSources, allowed.originalSources);
});

test('configuration rejects malformed bindings, caller-supplied receipts and unsafe source bounds', () => {
  for (const originalSources of [
    null, {}, [null], [{}], [{ ...binding(originalRef), sourceId: '' }],
    [{ ...binding(originalRef), receipt: { status: 'verified' } }],
    [binding(null)], [binding({ ...originalRef, sessionId: 'unauthorized' })],
    [binding({ ...originalRef, seq: -1 })], [binding({ ...originalRef, seq: 0.5 })],
    [binding({ ...originalRef, seq: Number.MAX_SAFE_INTEGER + 1 })],
    [binding({ ...originalRef, blockIndex: -1 })], [binding({ ...originalRef, blockIndex: '0' })],
    [binding({ ...originalRef, quote: '' })], [binding({ ...originalRef, quote: ' ' })],
    [binding({ ...originalRef, role: 'user' })], [binding({ ...originalRef, eventHash: 'forged' })],
    Array.from({ length: 65 }, () => binding(originalRef)),
  ]) {
    const value = { ...minimal, originalSources };
    assert.throws(() => validateConfig(value), TypeError);
    assert.ok(Config['~standard'].validate(value).issues.length);
  }
  for (const changes of [
    { sourceSessionIds: null }, { sourceSessionIds: 'session' }, { sourceSessionIds: ['a', 'a'] },
    { sourceSessionIds: [''] }, { sourceSessionIds: [7] }, { sourceSessionIds: Array.from({ length: 17 }, (_, i) => `session-${i}`) },
    { maxOriginalBytes: 0 }, { maxOriginalBytes: -1 }, { maxOriginalBytes: 1.5 }, { maxOriginalBytes: '65536' },
    { reinforcementBoost: -0.1 }, { reinforcementBoost: 1.01 }, { reinforcementBoost: NaN }, { reinforcementBoost: Infinity }, { reinforcementBoost: '0.25' },
  ]) assert.throws(() => validateConfig({ ...minimal, ...changes }), TypeError);
  assert.equal(validateConfig({ ...minimal, reinforcementBoost: 0 }).reinforcementBoost, 0);
  assert.equal(validateConfig({ ...minimal, reinforcementBoost: 1 }).reinforcementBoost, 1);
});

test('original quote limits count complete UTF-8 bytes rather than characters', () => {
  const originalSources = [binding({ ...originalRef, quote: '鱼a' })];
  assert.deepEqual(validateConfig({ ...minimal, maxOriginalBytes: 4, originalSources }).originalSources, originalSources);
  assert.throws(() => validateConfig({ ...minimal, maxOriginalBytes: 3, originalSources }), /bounded quote/);
});

test('recall history has explicit independent read budgets without widening generation', () => {
  for (const changes of [{ recallHistoryDays: -1 }, { recallHistoryDays: 3651 }, { recallHistoryDays: '90' }, { maxRecallFiles: 0 }, { maxRecallFiles: 1025 }, { maxRecallBytes: 511 }, { maxRecallBytes: 8388609 }]) assert.throws(() => validateConfig({ ...minimal, ...changes }));
  assert.equal(validateConfig({ ...minimal, recallHistoryDays: 0 }).recallHistoryDays, 0);
  assert.equal(validateConfig({ ...minimal, maxRecallBytes: 512 }).maxRecallBytes, 512);
});

test('independent dream authorization, bounds and mood remain explicit configuration', () => {
  for (const changes of [
    { dreamMode: 'auto' }, { maxEpisodes: 0 }, { maxEpisodes: 129 }, { dreamTimeoutMs: 0 },
    { maxDreamContextBytes: 511 }, { maxDreamContextBytes: 65537 }, { dreamContextRefs: null },
    { dreamContextRefs: [{ sessionId: 'other', seq: 1 }] }, { dreamContextRefs: [{ sessionId: minimal.sessionId, seq: -1 }] },
    { dreamContextRefs: Array(17).fill({ sessionId: minimal.sessionId, seq: 1 }) },
    { dreamMood: { text: 'background', at: 'yesterday' } }, { dreamMood: { text: '', at: '2026-11-04T00:00:00Z' } },
    { dreamMood: { text: '灯'.repeat(1000), at: '2026-11-04T00:00:00Z' } },
    { dreamMood: { text: 'background', at: '2026-11-04T00:00:00Z', approval: true } },
  ]) assert.throws(() => validateConfig({ ...minimal, ...changes }));
  const valid = validateConfig({ ...minimal, dreamMode: 'off', dreamContextRefs: [{ sessionId: minimal.sessionId, seq: 0 }], dreamMood: { text: 'A fictional quiet mood.', at: '2026-11-04T00:00:00Z' } });
  assert.equal(valid.dreamMode, 'off'); assert.equal(valid.dreamContextRefs.length, 1);
});

test('unsupported dry-run flags and invalid installation settings cannot silently enable writes', () => {
  for (const changes of [
    { compactionMode: 'once' }, { compactionMode: null }, { singleRun: 'true' }, { singleRun: 1 },
    { mode: 'dry-run' }, { enabled: false }, { sessionId: '' }, { memoryRoot: '../memory' },
    { stateRoot: '/synthetic/memory' }, { start: '25:00' }, { end: '05:00' },
    { timeZone: 'not/a/timezone' }, { timeoutMs: 0 }, { maxSourceBytes: 9999999 },
  ]) {
    assert.throws(() => validateConfig({ ...minimal, ...changes }));
    assert.ok(Config['~standard'].validate({ ...minimal, ...changes }).issues.length);
  }
});
