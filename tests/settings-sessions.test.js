import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsSessionDirectory, isMainConversation } from '../dist/settings/sessions.js';
import { SettingsFailure } from '../dist/settings/contracts.js';

const row = (id, header = {}, flags = {}) => ({ header: { id, version: 4, createdAt: 1, isSeeded: false, ...header }, live: false, persisted: true, ...flags });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(records = []) {
  const state = { records, time: 10000, list: undefined };
  const calls = { get: [], list: [], live: [], projection: [], cached: [], predecessor: [], cold: [] };
  const live = new Map(), liveTitles = new Map(), cachedTitles = new Map(), predecessorTitles = new Map();
  const forbidden = name => () => { calls.cold.push(name); throw new Error(`Forbidden cold operation: ${name}`); };
  const query = {
    listSessions(signal) {
      calls.list.push(signal);
      return state.list ? state.list(signal) : Promise.resolve(state.records);
    },
    readTitleSnapshots: forbidden('readTitleSnapshots'), readTitleSnapshot: forbidden('readTitleSnapshot'),
    readSession: forbidden('readSession'), observeSession: forbidden('observeSession'),
    readEvent: forbidden('readEvent'), listEvents: forbidden('listEvents'), searchEvents: forbidden('searchEvents'),
  };
  const services = new Map([
    ['sessionQuery', query],
    ['sessions', { get(id) { calls.live.push(id); return live.get(id); } }],
    ['sessionProjections', { snapshot(session, keys) {
      calls.projection.push({ session, keys });
      return { values: { title: liveTitles.get(session.id) ?? null } };
    } }],
    ['sessionProjectionCache', {
      cachedSnapshot(header, keys) {
        calls.cached.push({ header, keys });
        return cachedTitles.has(header.id) ? { values: { title: cachedTitles.get(header.id) } } : undefined;
      },
      cachedPredecessorTitle(header) {
        calls.predecessor.push(header);
        return predecessorTitles.has(header.id) ? { values: { title: predecessorTitles.get(header.id) } } : undefined;
      },
    }],
  ]);
  const ctx = { get(name) {
    calls.get.push(name);
    assert.ok(services.has(name), `No undeclared service lookup: ${name}`);
    return services.get(name);
  } };
  return { state, calls, live, liveTitles, cachedTitles, predecessorTitles, services, query,
    directory: createSettingsSessionDirectory(ctx, () => state.time) };
}

function unavailable(error) { return error instanceof SettingsFailure && error.code === 'UNAVAILABLE'; }

test('main-conversation predicate rejects delegated agents but retains ordinary user forks', () => {
  for (const header of [
    { id: 'main' }, { id: 'root', delegationDepth: 0 },
    { id: 'ordinary-fork', parentSession: 'parent', isSeeded: true },
    { id: 'ordinary-fork-zero', parentSession: 'parent', isSeeded: true, delegationDepth: 0 },
  ]) assert.equal(isMainConversation(header), true);
  for (const header of [
    { id: 'child', origin: 'subagent' }, { id: 'child-zero', origin: 'subagent', delegationDepth: 0 },
    { id: 'child-depth', delegationDepth: 1 }, { id: 'grandchild', delegationDepth: 2, parentSession: 'main' },
  ]) assert.equal(isMainConversation(header), false);
});

test('filters many child sessions before the result cap or any title lookup', async () => {
  const children = Array.from({ length: 1500 }, (_, i) => row(`child-${i}`, i % 2 ? { origin: 'subagent' } : { delegationDepth: 1 }));
  const mains = Array.from({ length: 105 }, (_, i) => row(`main-${i}`));
  const f = fixture([...children, ...mains]);
  const result = await f.directory.search('');
  assert.equal(result.items.length, 100);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items.map(item => item.id), mains.slice(0, 100).map(item => item.header.id));
  assert.deepEqual(f.calls.live, mains.map(item => item.header.id));
  assert.ok(f.calls.cached.every(call => call.header.id.startsWith('main-')));
  assert.equal(f.calls.cached.length, 105);
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('ordinary forks remain discoverable and excluded children do not imply truncation', async () => {
  const f = fixture([row('child', { origin: 'subagent' }), row('root'), row('fork', { parentSession: 'root', isSeeded: true })]);
  const result = await f.directory.search('');
  assert.deepEqual(result.items.map(item => item.id), ['root', 'fork']);
  assert.equal(result.truncated, false);
  assert.deepEqual(f.calls.live, ['root', 'fork']);
  await f.directory.dispose();
});

test('title lookup uses exact live incremental projection and synchronous persisted caches only', async () => {
  const f = fixture([row('live'), row('cached'), row('migrated'), row('untitled'), row('null-title')]);
  const session = { id: 'live' };
  f.live.set('live', session); f.liveTitles.set('live', 'Live title');
  f.cachedTitles.set('cached', 'Cached title'); f.predecessorTitles.set('migrated', 'Predecessor title');
  f.cachedTitles.set('null-title', null);
  const result = await f.directory.search('');
  assert.deepEqual(result.items.map(item => [item.id, item.title, item.live]), [
    ['live', 'Live title', true], ['cached', 'Cached title', false], ['migrated', 'Predecessor title', false],
    ['untitled', 'untitled', false], ['null-title', 'null-title', false],
  ]);
  assert.deepEqual(f.calls.projection, [{ session, keys: ['title', 'sessionListMetadata'] }]);
  assert.ok(f.calls.cached.every(call => call.header.id !== 'live'));
  assert.ok(f.calls.cached.every(call => assert.deepEqual(call.keys, ['title', 'sessionListMetadata']) === undefined));
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('null live projection can fall back to cached metadata without reading transcript content', async () => {
  const f = fixture([row('live-null', {}, { live: true }), row('flag-live', {}, { live: true })]);
  f.live.set('live-null', { id: 'live-null' }); f.liveTitles.set('live-null', null);
  f.cachedTitles.set('live-null', 'Metadata title');
  const result = await f.directory.search('');
  assert.equal(result.items[0].title, 'Metadata title');
  assert.equal(result.items[0].live, true);
  assert.equal(result.items[1].live, true);
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('search matches title id and path case-insensitively after trimming', async () => {
  const f = fixture([row('Mixed-Id', { cwd: '/Synthetic/ProjectOne' }), row('other', { cwd: '/Synthetic/Elsewhere' })]);
  f.cachedTitles.set('Mixed-Id', 'Important Memory'); f.cachedTitles.set('other', 'Unrelated');
  for (const query of ['  IMPORTANT memory  ', 'mixed-ID', 'projectONE']) {
    const result = await f.directory.search(query);
    assert.deepEqual(result.items.map(item => item.id), ['Mixed-Id']);
    assert.equal(result.items[0].cwd, '/Synthetic/ProjectOne');
    assert.equal(result.truncated, false);
  }
  assert.deepEqual(await f.directory.search('not present'), { items: [], truncated: false });
  assert.equal(f.calls.list.length, 1, 'typing burst shares metadata headers');
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('search applies cap after main filtering and after matching rather than before title search', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => row(`root-${i}`));
  const f = fixture(rows);
  f.cachedTitles.set('root-149', 'Rare matching title');
  assert.deepEqual((await f.directory.search('rare')).items.map(item => item.id), ['root-149']);
  assert.equal((await f.directory.search('rare')).truncated, false);
  assert.equal((await f.directory.search('root')).items.length, 100);
  assert.equal((await f.directory.search('root')).truncated, true);
  await f.directory.dispose();
});

test('header cache lasts less than two seconds, refreshes exactly at TTL and honors invalidate', async () => {
  const f = fixture([row('initial')]);
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['initial']);
  f.state.records = [row('new')];
  f.state.time += 1999;
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['initial']);
  assert.equal(f.calls.list.length, 1);
  f.state.time++;
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['new']);
  assert.equal(f.calls.list.length, 2);
  f.state.records = [row('invalidated')];
  f.directory.invalidate();
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['invalidated']);
  assert.equal(f.calls.list.length, 3);
  await f.directory.dispose();
});

test('fresh title caches are reread on every query even while header records are cached', async () => {
  const f = fixture([row('live'), row('persisted')]);
  f.live.set('live', { id: 'live' }); f.liveTitles.set('live', 'Old live'); f.cachedTitles.set('persisted', 'Old cache');
  assert.equal((await f.directory.search('old')).items.length, 2);
  f.liveTitles.set('live', 'Renamed live'); f.cachedTitles.set('persisted', 'Renamed cache');
  assert.deepEqual((await f.directory.search('renamed')).items.map(item => item.title), ['Renamed live', 'Renamed cache']);
  assert.deepEqual((await f.directory.search('old')).items, []);
  assert.equal(f.calls.list.length, 1);
  assert.equal(f.calls.projection.length, 3);
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('cached headers and returned items are detached from backend and caller mutations', async () => {
  const f = fixture([row('root', { cwd: '/Synthetic/Original' })]);
  const result = await f.directory.search('');
  f.state.records[0].header.id = 'mutated-backend'; f.state.records[0].header.cwd = '/Synthetic/Mutated';
  result.items[0].id = 'mutated-caller'; result.items[0].title = 'caller';
  assert.deepEqual((await f.directory.search('')).items, [{ id: 'root', title: 'root', cwd: '/Synthetic/Original', live: false }]);
  await f.directory.dispose();
});

test('simultaneous searches share one header fetch without exposing caller cancellation to that fetch', async () => {
  const f = fixture();
  const pending = deferred(); f.state.list = () => pending.promise;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = f.directory.search('alpha', firstController.signal);
  const second = f.directory.search('beta', secondController.signal);
  await tick();
  assert.equal(f.calls.list.length, 1);
  assert.notEqual(f.calls.list[0], firstController.signal);
  assert.notEqual(f.calls.list[0], secondController.signal);
  pending.resolve([row('alpha'), row('beta')]);
  assert.deepEqual((await first).items.map(item => item.id), ['alpha']);
  assert.deepEqual((await second).items.map(item => item.id), ['beta']);
  await f.directory.dispose();
});

test('aborting an old query immediately detaches only that caller while a new query completes', async () => {
  const f = fixture();
  const pending = deferred(); f.state.list = () => pending.promise;
  const controller = new AbortController();
  const stopped = new Error('superseded synthetic query');
  const old = f.directory.search('old', controller.signal);
  const current = f.directory.search('new');
  const rejected = assert.rejects(old, error => error === stopped);
  await tick();
  controller.abort(stopped);
  await rejected;
  assert.equal(f.calls.list[0].aborted, false, 'shared owner signal must remain live');
  pending.resolve([row('new')]);
  assert.deepEqual((await current).items.map(item => item.id), ['new']);
  assert.equal(f.calls.list.length, 1);
  await f.directory.dispose();
});

test('pre-aborted search performs no lookup even when headers are already cached', async () => {
  const f = fixture([row('root')]);
  const stopped = new Error('cancelled before typing request');
  await assert.rejects(f.directory.search('', AbortSignal.abort(stopped)), error => error === stopped);
  assert.deepEqual(f.calls.get, []);
  await f.directory.search('');
  const before = { get: f.calls.get.length, live: f.calls.live.length, list: f.calls.list.length };
  await assert.rejects(f.directory.search('', AbortSignal.abort(stopped)), error => error === stopped);
  assert.deepEqual({ get: f.calls.get.length, live: f.calls.live.length, list: f.calls.list.length }, before);
  await f.directory.dispose();
});

test('dispose aborts the owner header fetch and drains its actual settlement before returning', async () => {
  const f = fixture();
  const pending = deferred(); f.state.list = () => pending.promise;
  const searching = f.directory.search('');
  const rejected = assert.rejects(searching, /Session directory owner disposed/);
  await tick();
  let disposed = false;
  const disposal = f.directory.dispose().then(() => { disposed = true; });
  await tick();
  assert.equal(f.calls.list[0].aborted, true);
  assert.equal(disposed, false, 'uncooperative backend is not falsely claimed drained');
  pending.resolve([row('late')]);
  await disposal;
  await rejected;
  const before = f.calls.get.length;
  await assert.rejects(f.directory.search(''), unavailable);
  assert.equal(f.calls.get.length, before);
  await f.directory.dispose();
});

test('source replacement while metadata reads run drains every source during disposal', async () => {
  const f = fixture();
  const older = deferred(), newer = deferred();
  f.state.list = () => older.promise;
  const first = f.directory.search('');
  const firstRejected = assert.rejects(first, /Session directory owner disposed/);
  await tick();
  let secondSignal, secondCalls = 0;
  f.services.set('sessionQuery', { listSessions(signal) { secondCalls++; secondSignal = signal; return newer.promise; } });
  const second = f.directory.search('');
  const secondRejected = assert.rejects(second, /Session directory owner disposed/);
  await tick();
  assert.equal(f.calls.list.length, 1);
  assert.equal(secondCalls, 1);
  let drained = false;
  const disposal = f.directory.dispose().then(() => { drained = true; });
  await tick();
  assert.equal(f.calls.list[0].aborted, true);
  assert.equal(secondSignal.aborted, true);
  newer.resolve([row('new-source')]);
  await secondRejected;
  await tick();
  assert.equal(drained, false, 'the obsolete source is still real outstanding I/O');
  older.resolve([row('old-source')]);
  await firstRejected;
  await disposal;
  assert.equal(drained, true);
  await assert.rejects(f.directory.search(''), unavailable);
});

test('invalidating pending headers starts a new generation and late old rows never overwrite it', async () => {
  const f = fixture();
  const older = deferred(), newer = deferred();
  let count = 0;
  f.state.list = () => (++count === 1 ? older.promise : newer.promise);
  const first = f.directory.search('');
  await tick();
  f.directory.invalidate();
  const second = f.directory.search('');
  await tick();
  assert.equal(f.calls.list.length, 2, 'new generation must not join the invalidated fetch');
  newer.resolve([row('fresh-generation')]);
  assert.deepEqual((await second).items.map(item => item.id), ['fresh-generation']);
  older.resolve([row('older-generation')]);
  assert.deepEqual((await first).items.map(item => item.id), ['older-generation'], 'an older caller may retain its own observed page');
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['fresh-generation']);
  assert.equal(f.calls.list.length, 2, 'late old page must neither poison nor evict the fresh cache');
  await f.directory.dispose();
});

test('header failures do not poison future searches or trigger any replay fallback', async () => {
  const f = fixture([row('recovered')]);
  const error = new Error('synthetic unavailable metadata backend');
  f.state.list = () => Promise.reject(error);
  await assert.rejects(f.directory.search(''), value => value === error);
  f.state.list = undefined;
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['recovered']);
  assert.equal(f.calls.list.length, 2);
  assert.deepEqual(f.calls.cold, []);
  await f.directory.dispose();
});

test('missing metadata service rejects, while missing title caches fall back only to session ids', async () => {
  const missing = fixture(); missing.services.set('sessionQuery', undefined);
  await assert.rejects(missing.directory.search(''), unavailable);
  assert.deepEqual(missing.calls.list, []);
  await missing.directory.dispose();
  const noTitles = fixture([row('id-only')]);
  for (const key of ['sessions', 'sessionProjections', 'sessionProjectionCache']) noTitles.services.set(key, undefined);
  assert.deepEqual(await noTitles.directory.search('ID-ONLY'), { items: [{ id: 'id-only', title: 'id-only', live: false }], truncated: false });
  assert.deepEqual(noTitles.calls.cold, []);
  await noTitles.directory.dispose();
});

test('Cordis wrappers share original-service cache but replacing the service invalidates it', async () => {
  const f = fixture([row('old-service')]);
  const original = Symbol.for('cordis.original');
  f.services.set('sessionQuery', { [original]: f.query, listSessions: signal => f.query.listSessions(signal) });
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['old-service']);
  f.services.set('sessionQuery', { [original]: f.query, listSessions: signal => f.query.listSessions(signal) });
  await f.directory.search('');
  assert.equal(f.calls.list.length, 1, 'rebinding one Cordis original does not refetch headers');
  let replacementCalls = 0;
  f.services.set('sessionQuery', { listSessions: async () => { replacementCalls++; return [row('replacement-service')]; } });
  assert.deepEqual((await f.directory.search('')).items.map(item => item.id), ['replacement-service']);
  assert.equal(replacementCalls, 1);
  await f.directory.dispose();
});
