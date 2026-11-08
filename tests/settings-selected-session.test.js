import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createSettingsSessionDirectory } from '../dist/settings/sessions.js';
function fixture() {
  const live = new Map(), titles = new Map(), headers = new Map(), cached = new Map(), predecessor = new Map();
  const calls = { stats: [], snapshots: [], cached: [], predecessor: [] };
  const services = {
    sessions: { get: id => live.get(id) },
    sessionProjections: { snapshot(session, keys) { calls.snapshots.push({ id: session.header.id, keys }); return { values: { title: titles.get(session.header.id) } }; } },
    sessionPersistence: { async stat(id, options) { calls.stats.push({ id, options }); return headers.has(id) ? { header: headers.get(id) } : undefined; } },
    sessionProjectionCache: {
      cachedSnapshot(header, keys) { calls.cached.push({ id: header.id, keys }); return cached.has(header.id) ? { values: { title: cached.get(header.id) } } : undefined; },
      cachedPredecessorTitle(header) { calls.predecessor.push(header.id); return predecessor.has(header.id) ? { values: { title: predecessor.get(header.id) } } : undefined; },
    },
    sessionQuery: new Proxy({}, { get() { assert.fail('Selected title lookup must not list, search or replay any conversation'); } }),
  };
  const directory = createSettingsSessionDirectory({ get(key) { assert.ok(key in services); return services[key]; } });
  return { directory, live, titles, headers, cached, predecessor, calls, services };
}
test('saved live session name comes from title projection only, without listing or persistence I/O', async () => {
  const f = fixture(); f.live.set('chosen', { header: { id: 'chosen', cwd: '/synthetic/project' } }); f.titles.set('chosen', 'Saved target title');
  assert.deepEqual(await f.directory.resolveSelected(['chosen']), [{ id: 'chosen', title: 'Saved target title', cwd: '/synthetic/project', live: true }]);
  assert.deepEqual(f.calls.stats, []); assert.deepEqual(f.calls.cached, []); assert.deepEqual(f.calls.snapshots, [{ id: 'chosen', keys: ['title'] }]);
  await f.directory.dispose();
});
test('cold saved titles use exact header stat and lifecycle-validated cache, never full listing or logs', async () => {
  const f = fixture(); f.headers.set('cold', { id: 'cold', version: 4, createdAt: 10, cwd: '/synthetic/cold' }); f.cached.set('cold', 'Cold title');
  f.headers.set('old-format', { id: 'old-format' }); f.predecessor.set('old-format', 'Old title');
  assert.deepEqual((await f.directory.resolveSelected(['cold', 'old-format'])).map(item => item.title), ['Cold title', 'Old title']);
  assert.deepEqual(f.calls.stats.map(call => call.id), ['cold', 'old-format']);
  assert.ok(f.calls.stats.every(call => call.options.signal instanceof AbortSignal));
  assert.ok(f.calls.cached.every(call => assert.deepEqual(call.keys, ['title']) === undefined));
  await f.directory.dispose();
});
test('selected blank, delegated or unavailable IDs remain explicitly selected instead of being silently replaced', async () => {
  const f = fixture();
  f.live.set('existing-child', { header: { id: 'existing-child', origin: 'subagent' } }); f.titles.set('existing-child', 'Previously selected');
  f.headers.set('untitled', { id: 'untitled' }); f.cached.set('untitled', null);
  assert.deepEqual((await f.directory.resolveSelected(['existing-child', 'untitled', 'missing'])).map(item => [item.id, item.title]), [['existing-child', 'Previously selected'], ['untitled', 'untitled'], ['missing', 'missing']]);
  await f.directory.dispose();
});
test('saved lookup deduplicates authorized IDs, rereads names and bounds work to target plus 16 sources', async () => {
  const f = fixture(); f.live.set('chosen', { header: { id: 'chosen' } }); f.titles.set('chosen', 'First');
  assert.equal((await f.directory.resolveSelected(['chosen', 'chosen'])).length, 1);
  f.titles.set('chosen', 'Renamed'); assert.equal((await f.directory.resolveSelected(['chosen']))[0].title, 'Renamed');
  assert.equal((await f.directory.resolveSelected(Array.from({ length: 40 }, (_, i) => 'saved-' + i))).length, 17);
  await f.directory.dispose();
});
test('a Session becoming live during stat supplies the newer title', async () => {
  const f = fixture(); f.services.sessionPersistence.stat = async id => {
    f.live.set(id, { header: { id, cwd: '/synthetic/live' } }); f.titles.set(id, 'Now live');
    return { header: { id, cwd: '/synthetic/old' } };
  };
  assert.deepEqual(await f.directory.resolveSelected(['chosen']), [{ id: 'chosen', title: 'Now live', cwd: '/synthetic/live', live: true }]);
  await f.directory.dispose();
});
test('abort rejects without calls and disposal drains in-flight stat reads', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.directory.resolveSelected(['chosen'], abort.signal)); assert.deepEqual(f.calls.stats, []);
  let finish, seenSignal; f.services.sessionPersistence.stat = (_id, options) => { seenSignal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const result = f.directory.resolveSelected(['chosen']); let disposed = false;
  const cleanup = f.directory.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(seenSignal.aborted, true); assert.equal(disposed, false);
  finish(undefined); await assert.rejects(result); await cleanup;
});
test('initial page consumes server-provided option labels before exposing the form without eager search', async () => {
  const source = await readFile(new URL('../client/SettingsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /setSessions\(value\.sessionOptions \?\? \[\]\)/);
  assert.match(source, /await api\.read\(controller\.signal\)/);
  assert.match(source, /if \(mounted\.current && !controller\.signal\.aborted\) \{ accept\(value\)/);
  const load = source.slice(source.indexOf('const load = React.useCallback'), source.indexOf('function update('));
  assert.doesNotMatch(load, /void searchSessions|void api\.sessions|await api\.sessions/); // no mount-triggered search request
});
