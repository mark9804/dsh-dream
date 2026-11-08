import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsSessionDirectory } from '../dist/settings/sessions.js';
function fixture(ids) {
  const live = new Map(), attached = new Map(), stored = new Map(), calls = { cold: 0, keys: [] };
  const services = {
    sessionQuery: { async listSessions() { return ids.map(id => ({ header: { id }, live: live.has(id), persisted: true })); }, async observeSession() { calls.cold++; assert.fail('Never replay cold logs'); } },
    sessions: { get(id) { return live.get(id); } },
    sessionProjections: { snapshot(session, keys) { calls.keys.push(keys); return { values: attached.get(session.id) ?? {} }; } },
    sessionProjectionCache: { cachedSnapshot(header, keys) { calls.keys.push(keys); return stored.has(header.id) ? { values: stored.get(header.id) } : undefined; }, cachedPredecessorTitle() { return undefined; } },
  };
  return { directory: createSettingsSessionDirectory({ get: key => services[key] }), live, attached, stored, calls };
}
const ids = async directory => (await directory.search('')).items.map(item => item.id);
test('explicit cold blank true is excluded, but null titles or unknown blankness remain', async () => {
  const f = fixture(['blank', 'untitled-with-content', 'unknown', 'missing-cache']);
  f.stored.set('blank', { title: null, sessionListMetadata: { blank: true, lastPromptAt: null } });
  f.stored.set('untitled-with-content', { title: null, sessionListMetadata: { blank: false, lastPromptAt: 42 } });
  f.stored.set('unknown', { title: null });
  assert.deepEqual(await ids(f.directory), ['untitled-with-content', 'unknown', 'missing-cache']);
  assert.equal(f.calls.cold, 0); assert.ok(f.calls.keys.every(keys => keys.includes('sessionListMetadata')));
  await f.directory.dispose();
});
test('live nonblank wins over stale cached blank and missing live state is not hidden', async () => {
  const f = fixture(['started', 'missing-live', 'blank-live']);
  for (const id of ['started', 'missing-live', 'blank-live']) f.live.set(id, { id });
  f.attached.set('started', { title: null, sessionListMetadata: { blank: false } });
  f.attached.set('blank-live', { title: 'A selected draft title', sessionListMetadata: { blank: true } });
  for (const id of ['started', 'missing-live']) f.stored.set(id, { sessionListMetadata: { blank: true } });
  assert.deepEqual(await ids(f.directory), ['started', 'missing-live']);
  await f.directory.dispose();
});
test('only literal true proves blankness; malformed truthy fields do not hide items', async () => {
  const f = fixture(['string-true', 'number-one', 'null', 'false']);
  for (const [id, blank] of [['string-true', 'true'], ['number-one', 1], ['null', null], ['false', false]]) f.stored.set(id, { sessionListMetadata: { blank } });
  assert.deepEqual(await ids(f.directory), ['string-true', 'number-one', 'null', 'false']);
  await f.directory.dispose();
});
test('blank is reevaluated every search and a newly started session immediately appears', async () => {
  const f = fixture(['started-later']); f.live.set('started-later', { id: 'started-later' });
  f.attached.set('started-later', { sessionListMetadata: { blank: true } });
  assert.deepEqual(await ids(f.directory), []);
  f.attached.set('started-later', { sessionListMetadata: { blank: false } });
  assert.deepEqual(await ids(f.directory), ['started-later']);
  await f.directory.dispose();
});
test('blank filtering occurs before query matching and result-cap accounting', async () => {
  const blanks = Array.from({ length: 150 }, (_, i) => `blank-${i}`), f = fixture([...blanks, 'retained']);
  for (const id of blanks) f.stored.set(id, { title: 'matching', sessionListMetadata: { blank: true } });
  f.stored.set('retained', { title: 'matching', sessionListMetadata: { blank: false } });
  assert.deepEqual(await f.directory.search('matching'), { items: [{ id: 'retained', title: 'matching', live: false }], truncated: false });
  await f.directory.dispose();
});
