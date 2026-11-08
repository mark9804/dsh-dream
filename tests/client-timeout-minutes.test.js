import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { draftOf, numericFields, serializeDraft, timeoutParts, isTimeoutParts, maximumTimeoutMs } from '../client/draft.ts';
import { en, zh } from '../client/locale.ts';

const timeoutFields = ['timeoutMs', 'dreamTimeoutMs'];
function fixture(changes = {}) {
  return { ...Object.fromEntries(Object.entries(numericFields).map(([field, rule]) => [field, rule.min])),
    sessionId: 'synthetic-session', memoryRoot: '/synthetic/memory', stateRoot: '/synthetic/state', start: '05:00', end: '07:00', timeZone: 'local', compactionMode: 'auto', singleRun: false,
    dreamMode: 'separate', sourceSessionIds: [], originalSources: [], dreamContextRefs: [], timeoutMs: 900000, dreamTimeoutMs: 180000, ...changes };
}
test('timeout fields use duration groups, defaults are 15/3 minutes and zero seconds', () => {
  for (const field of timeoutFields) { assert.equal(numericFields[field].duration, true); assert.equal(numericFields[field].max, maximumTimeoutMs); }
  const d = draftOf(fixture()); assert.deepEqual(d.timeoutMs, { minutes: '15', seconds: '0' }); assert.deepEqual(d.dreamTimeoutMs, { minutes: '3', seconds: '0' });
  assert.deepEqual(timeoutParts(90000), { minutes: '1', seconds: '30' });
});
test('saved values decompose without migration and unrelated saves preserve original timeouts', () => {
  const saved = fixture({ timeoutMs: 300000, dreamTimeoutMs: 185000 }), before = structuredClone(saved), d = draftOf(saved);
  assert.deepEqual(d.timeoutMs, { minutes: '5', seconds: '0' }); assert.deepEqual(d.dreamTimeoutMs, { minutes: '3', seconds: '5' });
  assert.deepEqual(serializeDraft(d), { config: saved, errors: {} }); assert.deepEqual(saved, before);
  d.maxProposals = '8'; assert.equal(serializeDraft(d).config.timeoutMs, 300000); assert.equal(serializeDraft(d).config.dreamTimeoutMs, 185000);
});
test('minute and second edits serialize separately and blank seconds default to zero', () => {
  for (const field of timeoutFields) for (const [parts, expected] of [
    [{ minutes: '1', seconds: '30' }, 90000], [{ minutes: '0', seconds: '15' }, 15000], [{ minutes: '15', seconds: '' }, 900000],
    [{ minutes: '1', seconds: '0.001' }, 60001], [{ minutes: '0', seconds: '59.999' }, 59999],
  ]) { const d = draftOf(fixture()); d[field] = parts; const result = serializeDraft(d); assert.deepEqual(result.errors, {}); assert.equal(result.config[field], expected); assert.deepEqual(d[field], parts); }
});
test('all sampled legacy integer milliseconds round-trip exactly including subsecond and maximum values', () => {
  const samples = new Set([1, 2, 3, 7, 1001, 59999, 60000, 60001, 300001, 900001, maximumTimeoutMs - 1, maximumTimeoutMs]);
  for (let ms = 1; ms <= 600; ms++) samples.add(ms);
  let seed = 42; for (let i = 0; i < 2048; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; samples.add(seed % maximumTimeoutMs + 1); }
  for (const ms of samples) {
    const d = draftOf(fixture({ timeoutMs: ms, dreamTimeoutMs: ms })), result = serializeDraft(d);
    assert.deepEqual(result.errors, {}, `${ms}ms`); for (const field of timeoutFields) { assert.equal(result.config[field], ms); assert.ok(Number.isInteger(Number(d[field].minutes))); assert.ok(Number(d[field].seconds) < 60); }
  }
});
test('duration validation rejects invalid minutes, seconds and overflowing totals without silently normalizing', () => {
  const cases = [
    [{ minutes: '', seconds: '0' }, 'fieldNumber'], [{ minutes: 'NaN', seconds: '0' }, 'fieldNumber'], [{ minutes: '1', seconds: 'Infinity' }, 'fieldNumber'],
    [{ minutes: '1.5', seconds: '0' }, 'fieldInteger'], [{ minutes: '-1', seconds: '0' }, 'fieldTimeoutRange'], [{ minutes: '0', seconds: '0' }, 'fieldTimeoutRange'],
    [{ minutes: '1', seconds: '-1' }, 'fieldTimeoutRange'], [{ minutes: '1', seconds: '60' }, 'fieldTimeoutRange'], [{ minutes: '35791', seconds: '23.648' }, 'fieldTimeoutRange'],
    [{ minutes: '0', seconds: '0.0001' }, 'fieldTimeoutRange'], [{ minutes: '1', seconds: '0.0001' }, 'fieldTimeoutPrecision'], [{ minutes: '0', seconds: '1.2345' }, 'fieldTimeoutPrecision'],
  ];
  for (const field of timeoutFields) for (const [parts, code] of cases) { const d = draftOf(fixture()); d[field] = parts; assert.equal(serializeDraft(d).errors[field], code, JSON.stringify(parts)); assert.deepEqual(d[field], parts); }
  for (const invalid of ['15', 15, null, {}, { minutes: '1' }, { minutes: '1', seconds: '0', milliseconds: 99 }]) { assert.equal(isTimeoutParts(invalid), false); const d = draftOf(fixture()); d.timeoutMs = invalid; assert.equal(serializeDraft(d).errors.timeoutMs, 'fieldNumber'); }
});
test('ordinary numeric fields and disabled incomplete drafts keep existing semantics', () => {
  const d = draftOf(fixture({ reinforcementBoost: 0.125, maxSourceBytes: 1024, maxInputBytes: 2048 })); assert.equal(d.maxSourceBytes, '1024'); assert.equal(d.reinforcementBoost, '0.125'); assert.deepEqual(serializeDraft(d).errors, {});
  d.maxSourceBytes = '1024.5'; assert.equal(serializeDraft(d).errors.maxSourceBytes, 'fieldInteger');
  const incomplete = draftOf(fixture()); delete incomplete.sessionId; delete incomplete.memoryRoot; delete incomplete.stateRoot;
  assert.deepEqual(serializeDraft(incomplete, { enabled: false }).errors, {});
});
test('unit labels and budget copy describe minute plus second groups, not decimal minutes', async () => {
  assert.equal(en.seconds, 'sec'); assert.equal(zh.seconds, '秒'); assert.equal(zh.minutes, '分钟');
  for (const locale of [en, zh]) { assert.match(locale.help_timeoutMs, /15/); assert.match(locale.help_dreamTimeoutMs, /3/); assert.ok(locale.fieldTimeoutPrecision); assert.ok(locale.fieldTimeoutRange); }
  assert.match(en.help_timeoutMs, /Total budget.*fresh budget for each isolated review/); assert.match(zh.help_timeoutMs, /共用总预算.*每次独立审核另有同样预算/);
  const page = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8'); assert.match(page, /'duration' in rule \? <DurationInput/); assert.match(page, /minutesLabel=\{t\('minutes'\)\} secondsLabel=\{t\('seconds'\)\}/);
});
