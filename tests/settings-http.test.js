import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSettingsHttp } from '../dist/harness/settings-http.js';
import { SettingsFailure } from '../dist/settings/contracts.js';
function fixture(operation) { const routes = new Map(); registerSettingsHttp({ connection: { fetch: { register(route) { routes.set(route.path, route); } } }, get() {}, logger: { error() {} } }, { save: operation }); return routes.get('/api/dsh-dream/save'); }
const json = value => new Request('http://localhost/api/dsh-dream/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
test('settings HTTP registers exact POST owner-carried route and no-store JSON', async () => {
  let seen; const route = fixture(async value => { seen = value; return { saved: false }; });
  assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'buffered');
  const response = await route.fetch(json({ config: { singleRun: false, recallHistoryDays: 0 } }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, value: { saved: false } }); assert.equal(seen.config.recallHistoryDays, 0);
});
test('invalid JSON, content type and oversized input never reach settings operations', async () => {
  let called = 0; const route = fixture(async () => called++);
  for (const request of [new Request('http://localhost/api/dsh-dream/save', { method: 'POST', body: '{}' }), new Request('http://localhost/api/dsh-dream/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), json({ data: 'x'.repeat(262145) })]) {
    const response = await route.fetch(request); assert.ok([400, 413].includes(response.status)); assert.equal((await response.json()).ok, false);
  } assert.equal(called, 0);
});
test('domain revision conflict retains status/code and explicit details', async () => {
  const route = fixture(async () => { throw new SettingsFailure('SETTINGS_CONFLICT', 'changed', { reload: true }); });
  const response = await route.fetch(json({})); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'SETTINGS_CONFLICT', message: 'changed', details: { reload: true } } });
});
test('runtime validation and operational failures are honest not success', async () => {
  for (const [error, expected] of [[new TypeError('bad config'), [400, 'INVALID_CONFIGURATION']], [new Error('missing backend'), [503, 'UNAVAILABLE']]]) {
    const response = await fixture(async () => { throw error; }).fetch(json({})); assert.equal(response.status, expected[0]); assert.equal((await response.json()).error.code, expected[1]);
  }
});
