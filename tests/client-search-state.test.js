import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createLatestSearch, idleSearch, localOptionMatches, searchStatus } from '../client/search-state.ts';

// Pure state/controller tests with a deterministic clock, no DOM or React mock.
function clock() {
  let now = 0, next = 0;
  const callbacks = new Map();
  return {
    schedule(callback, delay) { const id = ++next; callbacks.set(id, { callback, at: now + delay }); return id; },
    cancel(id) { callbacks.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...callbacks]) if (entry.at <= now) { callbacks.delete(id); entry.callback(); }
    },
    get pending() { return callbacks.size; },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function fixture() {
  const timer = clock(), calls = [], states = [];
  const controller = createLatestSearch({ clock: timer,
    publish: state => states.push(state), describeError: error => error.message,
    request(query, signal) { const result = deferred(); calls.push({ query, signal, ...result }); return result.promise; },
  });
  return { timer, calls, states, controller, current: () => states.at(-1) };
}

test('search performs no initial I/O and publishes loading immediately during 200ms debounce', async () => {
  const f = fixture();
  assert.deepEqual(f.states, []);
  assert.deepEqual(f.calls, []);
  assert.equal(searchStatus(idleSearch().phase), 'searchPrompt');
  f.controller.search('synthetic title');
  assert.equal(f.current().phase, 'loading');
  assert.equal(searchStatus(f.current().phase), 'searchLoading');
  assert.deepEqual(f.current().items, []);
  f.timer.advance(199); assert.equal(f.calls.length, 0);
  f.timer.advance(1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].query, 'synthetic title');
  f.calls[0].resolve({ items: [], truncated: false }); await flush();
  assert.equal(f.current().phase, 'success');
  assert.equal(searchStatus(f.current().phase), null);
});

test('fast typing coalesces requests and never displays a prior empty answer as the new result', async () => {
  const f = fixture();
  f.controller.search('old'); f.timer.advance(200);
  f.calls[0].resolve({ items: [], truncated: false }); await flush();
  assert.equal(f.current().phase, 'success');
  f.controller.search('new'); f.timer.advance(100); f.controller.search('new title');
  assert.equal(f.current().phase, 'loading');
  assert.equal(searchStatus(f.current().phase), 'searchLoading');
  f.timer.advance(100); assert.equal(f.calls.length, 1);
  f.timer.advance(100); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].query, 'new title');
  f.calls[1].resolve({ items: [{ id: 'synthetic-id', title: 'New title' }], truncated: true }); await flush();
  assert.equal(f.current().phase, 'success');
  assert.equal(f.current().truncated, true);
});

test('newer query aborts in-flight old request and late stale completion cannot replace it', async () => {
  const f = fixture();
  f.controller.search('first'); f.timer.advance(200);
  f.controller.search('second'); assert.equal(f.calls[0].signal.aborted, true);
  f.timer.advance(200);
  f.calls[1].resolve({ items: [{ id: 'second' }], truncated: false }); await flush();
  f.calls[0].resolve({ items: [{ id: 'first' }], truncated: true }); await flush();
  assert.equal(f.current().query, 'second');
  assert.deepEqual(f.current().items, [{ id: 'second' }]);
});

test('failure is explicit, clears previous items and does not masquerade as no results', async () => {
  const f = fixture();
  f.controller.search('works'); f.timer.advance(200);
  f.calls[0].resolve({ items: [{ id: 'previous' }], truncated: false }); await flush();
  f.controller.search('fails');
  assert.deepEqual(f.current().items, []);
  f.timer.advance(200); f.calls[1].reject(new Error('Synthetic unavailable')); await flush();
  assert.equal(f.current().phase, 'error');
  assert.equal(f.current().error, 'Synthetic unavailable');
  assert.equal(searchStatus(f.current().phase), 'searchFailed');
  f.controller.search('retry'); assert.equal(f.current().error, null);
});

test('close cancels pending work, clears status, and does not announce cancellation as a failure', async () => {
  const f = fixture();
  f.controller.search('pending'); f.controller.cancel(); f.timer.advance(200);
  assert.equal(f.calls.length, 0); assert.equal(f.timer.pending, 0);
  assert.deepEqual(f.current(), idleSearch());
  f.controller.search('running'); f.timer.advance(200); f.controller.cancel();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].reject(new Error('Aborted')); await flush();
  assert.deepEqual(f.current(), idleSearch());
});

test('disposing cancels timers and active requests without publishing into an unmounted component', async () => {
  const f = fixture();
  f.controller.search('running'); f.timer.advance(200);
  const before = f.states.length; f.controller.dispose();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve({ items: [{ id: 'ignored' }], truncated: false }); await flush();
  f.controller.search('never'); f.controller.cancel(); f.timer.advance(1000);
  assert.equal(f.states.length, before); assert.equal(f.calls.length, 1);
});

test('local matching covers translated title, stable ID and path without case or width mismatch', () => {
  const option = { value: 'synthetic-session-42', label: '蓝鲸的研究会话', description: '/synthetic/Research/Project' };
  assert.equal(localOptionMatches(option, '研究'), true);
  assert.equal(localOptionMatches(option, 'SESSION-42'), true);
  assert.equal(localOptionMatches(option, 'ｒｅｓｅａｒｃｈ'), true);
  assert.equal(localOptionMatches(option, 'missing'), false);
  assert.equal(localOptionMatches(undefined, ''), false);
});

test('remote dropdowns use server result IDs, disable double filtering and expose loading/error status', async () => {
  const ui = await readFile(new URL('../client/ui.tsx', import.meta.url), 'utf8');
  assert.equal((ui.match(/filter=\{remoteSearch \? null/gu) ?? []).length, 2);
  assert.equal((ui.match(/filteredItems=\{remoteSearch/gu) ?? []).length, 2);
  assert.match(ui, /remoteSearch\.phase === 'success' \? t\('noResults'\) : null/u);
  assert.match(ui, /Combobox\.Status/u);
  assert.match(ui, /aria-busy=\{remoteSearch\?\.phase === 'loading'\}/u);
});

test('switch adapter avoids shared data slots and gives checked thumb a bounded symmetric track', async () => {
  const adapter = await readFile(new URL('../client/shadcn.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../client/styles.css', import.meta.url), 'utf8');
  assert.match(adapter, /nativeButton render=\{<button type="button"/u);
  assert.match(adapter, /data-slot="dream-settings-switch"/u);
  assert.match(adapter, /data-slot="dream-settings-switch-thumb"/u);
  assert.doesNotMatch(adapter, /data-slot="switch(?:-thumb)?"/u);
  assert.match(css, /\.dream-settings \.dream-settings-switch \{ appearance: none;/u);
  assert.match(css, /switch\[data-checked\] > \.dream-settings-switch-thumb \{ transform: translateX\(12px\)/u);
  assert.match(css, /inset-inline-start: 2px; top: 2px; width: 14px/u);
});
