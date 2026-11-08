import assert from 'node:assert/strict';
import test from 'node:test';
import { createNarrativeStore, releaseNarrativeAttempt } from '../dist/storage/narratives.js';
import { createDreamTasks } from '../dist/dream/tasks.js';
import { createFreeDreamWriter } from '../dist/dream/free-executor.js';

function fixture(overrides = {}) {
  const records = new Map(); let revision = 0; let queue = Promise.resolve();
  const files = {
    async read(path) { return records.get(path) ?? null; },
    async write(path, content, version) { assert.equal(records.get(path)?.version ?? null, version); const next = ++revision; records.set(path, { content, version: next }); return next; },
    async mkdir() {}, async stat() { return null; },
    async list(path) { return [...records.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')).map(p => ({ name: p.slice(path.length + 1), isDirectory: false })); },
    async withLock(_key, work) { const result = queue.then(work); queue = result.catch(() => {}); return result; },
  };
  const scope = { scopeId: 'scope', sessionId: 'session', agentId: 'session', memoryRootId: 'memory' };
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: '2026-11-04T05:30:00+09:00', sources: [{ sourceId: 'daily', path: 'daily/2026-11-04.md', content: 'The synthetic friend waited for the last train.', role: 'daily', version: 1, writable: false, sensitivity: 'private', protectedText: [] }] };
  const digest = { schemaVersion: 1, snapshotId: 'snapshot', episodes: [{ episodeId: 'job-event-1', summary: 'Waiting for a train.', when: 'unknown', participants: [], status: 'reported', category: 'relationship', importanceReason: 'Shared ordinary moment.', retention: 'recent', evidence: [{ sourceId: 'daily', quote: 'waited for the last train' }] }], coverage: { sourceIds: ['daily'], omittedSourceIds: [] } };
  const config = { dreamMode: 'separate', dreamTimeoutMs: 2000 };
  const conversation = { messages: [], coverage: { requested: 0, included: 0, omitted: 0, unavailable: 0, reasons: ['no_context_references'] } };
  const input = { schemaVersion: 1, jobId: 'job', snapshotId: 'snapshot', episodes: digest, conversation };
  const calls = { context: 0, writer: 0, published: [] };
  const store = createNarrativeStore(files, { root: 'state', scope });
  const options = { store, config, context: async () => { calls.context++; return structuredClone(conversation); }, writer: async () => { calls.writer++; return { dream: 'A train left through the kitchen.', afterFeeling: 'A little quiet.' }; }, publish: async task => { calls.published.push(structuredClone(task)); return 'state/dreams/26-11-04.md'; }, ...overrides };
  const tasks = createDreamTasks(options);
  return { records, files, scope, snapshot, digest, input, conversation, calls, store, options, tasks };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('independent task freezes inputs, persists output and publishes once across start/resume', async () => {
  const f = fixture(); f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04');
  f.digest.episodes[0].summary = 'CHANGED AFTER START';
  await f.tasks.flush();
  const stored = await f.store.get('job');
  assert.equal(stored.state, 'completed'); assert.equal(stored.attempts, 1); assert.equal(stored.input.episodes.episodes[0].summary, 'Waiting for a train.');
  assert.equal(f.calls.writer, 1); assert.equal(stored.output.afterFeeling, 'A little quiet.');
  const again = fixture();
  const restarted = createDreamTasks({ ...f.options, writer: again.options.writer });
  await restarted.resume(); restarted.start(f.snapshot, stored.input.episodes, 'job', '2026-11-04'); await restarted.flush();
  assert.equal(f.calls.published.length, 1); assert.equal(again.calls.writer, 0);
});

test('dreamMode off makes no context or model calls and creates an inspectable disabled task', async () => {
  const f = fixture({ config: { dreamMode: 'off', dreamTimeoutMs: 2000 } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal((await f.tasks.status('job')).state, 'disabled'); assert.equal(f.calls.context, 0); assert.equal(f.calls.writer, 0);
});

test('writer failure is local and explicit dream retry uses same frozen input without rerunning context', async () => {
  let tries = 0; const f = fixture({ writer: async () => { if (++tries === 1) throw new Error('synthetic model failure'); return { dream: 'Unfinished.', afterFeeling: '' }; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  const before = await f.store.get('job'); assert.equal(before.state, 'failed');
  await f.tasks.retry('job'); await f.tasks.flush(); const after = await f.store.get('job');
  assert.equal(after.state, 'completed'); assert.equal(after.inputDigest, before.inputDigest); assert.equal(after.attempts, 2); assert.equal(f.calls.context, 1);
});

test('in-flight task never holds storage lock and repeated starts never redraw', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ writer: async () => { entered.resolve(); await release.promise; return { dream: 'Pending cloud.', afterFeeling: '' }; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await entered.promise;
  assert.equal((await f.store.get('job')).state, 'generating');
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04');
  await assert.rejects(f.tasks.retry('job'), /running/); release.resolve(); await f.tasks.flush(); assert.equal((await f.store.get('job')).attempts, 1);
});

test('publication failure after persistence retries publication without a second model call', async () => {
  let publishes = 0; const f = fixture({ publish: async () => { if (++publishes === 1) throw new Error('synthetic file conflict'); return 'state/dreams/26-11-04.md'; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'failed');
  await f.tasks.retry('job'); await f.tasks.flush(); assert.equal(f.calls.writer, 1); assert.equal(publishes, 2);
});

test('resume finishes a recorded output without any inference or changing its attempt', async () => {
  const f = fixture(); await f.store.create('job', f.input, '2026-11-04', 'queued'); const claim = await f.store.claim('job');
  await f.store.result('job', claim.attemptId, { dream: 'Already recorded.', afterFeeling: 'A remainder.' });
  releaseNarrativeAttempt(claim.attemptId);
  await f.tasks.resume(); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'completed'); assert.equal(f.calls.writer, 0);
});

test('publication failure during resume becomes failed and can be explicitly retried', async () => {
  let count = 0; const f = fixture({ publish: async () => { if (++count === 1) throw new Error('resume write failed'); return 'dreams/recovered.md'; } });
  await f.store.create('job', f.input, '2026-11-04', 'queued'); const claim = await f.store.claim('job');
  await f.store.result('job', claim.attemptId, { dream: 'Saved before restart.', afterFeeling: '' });
  releaseNarrativeAttempt(claim.attemptId);
  await f.tasks.resume(); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'failed');
  await f.tasks.retry('job'); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'completed'); assert.equal(f.calls.writer, 0);
});

test('a late failed preparation cannot fail a different instance active attempt', async () => {
  const entered = deferred(), release = deferred(), writing = deferred(), finish = deferred();
  const f = fixture({ context: async () => { entered.resolve(); await release.promise; throw new Error('late preparation cancelled'); } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await entered.promise;
  const other = createDreamTasks({ ...f.options, context: async () => f.conversation, writer: async () => { writing.resolve(); await finish.promise; return { dream: 'Other owner output.', afterFeeling: '' }; } });
  other.start(f.snapshot, f.digest, 'job', '2026-11-04'); await writing.promise;
  release.resolve(); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'generating');
  finish.resolve(); await other.flush(); assert.equal((await f.store.get('job')).state, 'completed');
});

test('live-owner unfinished inference is not reissued on resume or an ordinary start', async () => {
  const f = fixture(); await f.store.create('job', f.input, '2026-11-04', 'queued'); await f.store.claim('job');
  await f.tasks.resume(); f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal((await f.store.get('job')).state, 'generating'); assert.equal(f.calls.writer, 0);
});

test('obsolete attempts, wrong scope, digest tampering and changed frozen input fail closed', async () => {
  const f = fixture(); await f.store.create('job', f.input, '2026-11-04', 'queued'); const claim = await f.store.claim('job');
  await assert.rejects(f.store.result('job', 'wrong-attempt', { dream: 'Forged.', afterFeeling: '' }), /Obsolete/);
  await assert.rejects(f.store.create('job', { ...f.input, mood: { text: 'New content', at: '2026-11-04T00:00:00Z' } }, '2026-11-04', 'queued'), /cannot change/);
  const other = createNarrativeStore(f.files, { root: 'state', scope: { ...f.scope, agentId: 'other' } }); await assert.rejects(other.get('job'), /scope mismatch/);
  const entry = f.records.get('state/dream-tasks/job.json'); const tampered = JSON.parse(entry.content); tampered.input.episodes.episodes[0].summary = 'Changed on disk';
  f.records.set('state/dream-tasks/job.json', { ...entry, content: JSON.stringify(tampered) }); await assert.rejects(f.store.get('job'), /digest mismatch/); assert.ok(claim.attemptId);
});

test('context acquisition failure creates local failed status without model dispatch', async () => {
  const f = fixture({ context: async () => { throw new Error('synthetic context error'); } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal((await f.tasks.status('job')).state, 'failed'); assert.equal(f.calls.writer, 0); assert.equal(f.calls.published.length, 0);
});

test('preparation failure has a dream-only retry using the frozen event basis', async () => {
  let contexts = 0; const f = fixture({ context: async () => { if (++contexts === 1) throw new Error('temporary history failure'); return { messages: [], coverage: { requested: 0, included: 0, omitted: 0, unavailable: 0, reasons: [] } }; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal((await f.store.get('job')).input, undefined);
  await f.tasks.retry('job', { snapshot: f.snapshot, digest: f.digest }); await f.tasks.flush();
  assert.equal((await f.store.get('job')).state, 'completed'); assert.equal(f.calls.writer, 1); assert.equal(contexts, 2);
});

test('oversized persisted output fails before writing an unreadable record and bounds failure text', async () => {
  const f = fixture({ writer: async () => ({ dream: 'x'.repeat(300000), afterFeeling: '' }) });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  const failed = await f.store.get('job'); assert.equal(failed.state, 'failed'); assert.match(failed.error.message, /byte budget/); assert.equal(f.calls.published.length, 0);
  await f.store.fail('job', { code: 'x'.repeat(1000), message: '灯'.repeat(500000) });
  assert.ok((await f.store.get('job')).error.message.length <= 2048);
});

test('same-process stopped attempt is recoverable but a live registered attempt is not redrawn', async () => {
  const f = fixture(); await f.store.create('job', f.input, '2026-11-04', 'queued'); const claim = await f.store.claim('job');
  await f.tasks.resume(); assert.equal((await f.store.get('job')).state, 'generating');
  releaseNarrativeAttempt(claim.attemptId); await f.tasks.resume(); assert.equal((await f.store.get('job')).state, 'failed'); assert.equal(f.calls.writer, 0);
  await f.tasks.retry('job'); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'completed');
});

test('cancellation drains uncooperative inference and persists failure without publishing late output', async () => {
  const entered = deferred(), release = deferred(); let op;
  const f = fixture({ writer: async (_input, { signal }) => { op = signal; entered.resolve(); await release.promise; return { dream: 'Late dream.', afterFeeling: '' }; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await entered.promise; f.tasks.stop(); assert.equal(op.aborted, true);
  let settled = false; const flush = f.tasks.flush().then(() => { settled = true; }); await new Promise(setImmediate); assert.equal(settled, false);
  release.resolve(); await flush; assert.equal((await f.store.get('job')).state, 'failed'); assert.equal(f.calls.published.length, 0);
});

test('sensitive source taints independent dream metadata without asking the model', async () => {
  const f = fixture(); f.snapshot.sources[0].sensitivity = 'sensitive'; f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal((await f.store.get('job')).sensitive, true); assert.equal(f.calls.published[0].sensitive, true);
});

test('explicit sensitive conversation or mood taints publication even without sensitive file sources', async () => {
  for (const mood of [false, true]) {
    const f = fixture({ ...(mood ? { config: { dreamMode: 'separate', dreamTimeoutMs: 2000, dreamMood: { text: '<!-- sensitive --> quiet context', at: '2026-11-04T00:00:00Z' } } } : { context: async () => ({ messages: [{ sessionId: 'session', seq: 1, role: 'user', text: '<!-- sensitive --> ordinary personal line' }], coverage: { requested: 1, included: 1, omitted: 0, unavailable: 0, reasons: [] } }) }) });
    f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush(); assert.equal((await f.store.get('job')).sensitive, true);
  }
});

test('stopped manager ignores late starts after its flush and never performs preparation I/O', async () => {
  const f = fixture(); f.tasks.stop(); await f.tasks.flush(); f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  assert.equal(await f.store.get('job'), null); assert.equal(f.calls.context, 0);
});

test('live publisher cannot be reclaimed by a second manager', async () => {
  const entered = deferred(), release = deferred(); let published = 0;
  const f = fixture({ publish: async () => { published++; entered.resolve(); await release.promise; return 'dream.md'; } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await entered.promise;
  const other = createDreamTasks(f.options); await other.resume(); await other.flush(); assert.equal(published, 1);
  release.resolve(); await f.tasks.flush(); assert.equal((await f.store.get('job')).state, 'completed');
});

test('claim cleanup handles a failure releasing the storage lock after successful persistence', async () => {
  const f = fixture(); await f.store.create('job', f.input, '2026-11-04', 'queued');
  const faulty = createNarrativeStore({ ...f.files, async withLock(key, work) { await f.files.withLock(key, work); throw new Error('release record failed'); } }, { root: 'state', scope: f.scope });
  await assert.rejects(faulty.claim('job'), /release record failed/);
  await f.tasks.resume(); assert.equal((await f.store.get('job')).state, 'failed'); assert.equal(f.calls.writer, 0);
});

test('abort during publication preflight cannot start a new publication afterwards', async () => {
  const ready = deferred(), release = deferred(); const f = fixture(); let finishedOutput = false;
  const guarded = { ...f.store, async result(...args) { const value = await f.store.result(...args); finishedOutput = true; return value; }, async get(id) { const value = await f.store.get(id); if (finishedOutput) { ready.resolve(); await release.promise; } return value; } };
  const tasks = createDreamTasks({ ...f.options, store: guarded }); tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await ready.promise; tasks.stop(); release.resolve(); await tasks.flush();
  assert.equal(f.calls.published.length, 0); assert.equal((await f.store.get('job')).state, 'failed');
});

test('near-limit output reserves room for later failure metadata', async () => {
  const f = fixture({ writer: async () => ({ dream: 'x'.repeat(247000), afterFeeling: '' }), publish: async () => { throw new Error('灯'.repeat(3000)); } });
  f.tasks.start(f.snapshot, f.digest, 'job', '2026-11-04'); await f.tasks.flush();
  const stored = await f.store.get('job'); assert.equal(stored.state, 'failed'); assert.ok(Buffer.byteLength(JSON.stringify(stored)) < 262144);
});

test('dream worker actually owns a separate orchestration event loop and gets only creative input', async () => {
  const f = fixture(); const prompts = []; const writer = createFreeDreamWriter(async prompt => { prompts.push(prompt); return JSON.stringify({ dream: 'The train had no wheels.', afterFeeling: 'Unsettled, briefly.' }); }, { timeoutMs: 2000, maxOutputBytes: 4096 });
  const result = await writer(f.input); assert.equal(result.dream, 'The train had no wheels.'); assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /provenance|rootIds|candidateView|ORGANIZE：|DEEP：/);
});
