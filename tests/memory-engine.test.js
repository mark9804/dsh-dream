import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateConfig } from '../dist/config.js';
import { createEngine } from '../dist/engine.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { createNarrativeStore } from '../dist/storage/narratives.js';
import { createDreamTasks } from '../dist/dream/tasks.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { syntheticCleanAuthority } from './helpers/clean-authority.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const output = { dream: 'A synthetic train floated through a blue kitchen.', afterFeeling: 'Briefly quieter.' };

async function fixture(t, { mode = 'separate', writer = async () => output } = {}) {
  const tmp = fileURLToPath(new URL('./.tmp/', import.meta.url)); await mkdir(tmp, { recursive: true }); const root = await mkdtemp(join(tmp, 'memory-v2-'));
  const base = createLocalFiles(root); const local = p => isAbsolute(p) ? relative(root, p) : p;
  const files = { ...base, read: (p, o) => base.read(local(p), o), write: (p, c, v) => base.write(local(p), c, v), stat: p => base.stat(local(p)), list: p => base.list(local(p)), mkdir: p => base.mkdir(local(p)) };
  const config = validateConfig({ sessionId: 'synthetic', memoryRoot: join(root, 'memory'), stateRoot: join(root, 'state'), compactionMode: 'agent', dreamMode: mode, timeZone: 'Asia/Tokyo' });
  for (const d of ['daily', 'ideas']) await files.mkdir(join(config.memoryRoot, d));
  for (const [p, text] of [['long-term.md', '# Synthetic memory\n'], ['decisions.md', '# Synthetic decisions\n'], ['journal.md', '# Synthetic journal\n'], ['daily/2026-11-04.md', 'SYNTHETIC: The red mug was a gift from River.\nSYNTHETIC: River liked waiting together for the last train.\n']]) await files.write(join(config.memoryRoot, p), text, null);
  const scope = { scopeId: 'synthetic', sessionId: 'synthetic', agentId: 'synthetic', memoryRootId: config.memoryRoot }; const actor = { agentId: scope.agentId, sessionId: scope.sessionId };
  const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot });
  const ns = createNarrativeStore(files, { root: config.stateRoot, scope }); const calls = { models: [], clean: [], review: [], context: 0, writtenDream: 0 };
  const controller = new AbortController();
  const tasks = createDreamTasks({ store: ns, config, signal: controller.signal, writer, context: async () => { calls.context++; return { messages: [{ sessionId: 'synthetic', seq: 5, role: 'user', text: 'Waiting together mattered, even when nothing happened.' }], coverage: { requested: 1, included: 1, omitted: 0, unavailable: 0, reasons: [] } }; }, publish: async task => { calls.writtenDream++; return store.appendDream({ jobId: task.jobId, date: task.date, text: `${task.output.dream}\n\n${task.output.afterFeeling}` }); } });
  const model = async prompt => {
    calls.models.push(prompt);
    if (prompt.startsWith('ORGANIZE：')) return JSON.stringify({ coveredSourceIds: ['daily/2026-11-04.md'], episodes: [{ summary: 'A synthetic friend gave the red mug.', when: 'unknown', participants: ['River'], status: 'reported', category: 'relationship', importanceReason: 'A shared object matters for companionship.', retention: 'durable', evidence: [{ sourceId: 'daily/2026-11-04.md', quote: 'The red mug was a gift from River.' }] }] });
    if (prompt.includes('\nDEEP：')) return JSON.stringify({ proposals: [{ kind: 'fact', text: 'Keep the origin of the synthetic mug.', reason: 'Direct synthetic event.', evidence: [{ sourceId: 'daily/2026-11-04.md', quote: 'The red mug was a gift from River.' }], targetId: 'long-term.md', operation: 'append', before: '', after: '- Synthetic: The red mug was a gift from River.\n', consolidation: { action: 'add', claimKey: 'synthetic-red-mug-origin', applicability: { topic: 'synthetic shared objects', conditions: 'Only this fictional red mug' }, basis: 'observation' } }] });
    throw new Error('Unexpected model stage');
  };
  const host = { async waitForIdle() {}, async maintain(work) { return work(new AbortController().signal); }, async compact() { throw new Error('No compaction expected'); }, async requestReview(text, receipt) { calls.review.push({ text, ...receipt }); }, async requestReload() {}, async notify() {} };
  const engine = createEngine({ config, scope, files, store, narratives: tasks, generate: createWorkerGenerator(model, config, 'memory-v2'), cleanReview: async (snapshot, proposal) => { calls.clean.push({ snapshot, proposal }); return { decision: 'accept', reason: 'Exact synthetic source supports the fact.', authority: syntheticCleanAuthority(snapshot, proposal) }; }, host, signal: controller.signal, now: () => new Date('2026-11-04T05:30:00+09:00') });
  t.after(async () => { controller.abort(new Error('Fixture done')); tasks.stop(); await engine.flush(); await tasks.flush(); });
  return { root, config, scope, actor, store, ns, tasks, calls, engine, files, controller };
}

async function commitAndReload(f, job) {
  await f.engine.review({ jobId: job.jobId, proposalId: job.proposals[0].proposalId, decision: 'review', reason: 'Please independently verify the source.' }, { actor: f.actor }); await f.engine.flush();
  let current = await f.store.loadJob(job.jobId); assert.equal(current.state, 'awaiting_compaction');
  await f.engine.decideCompaction({ jobId: job.jobId, transactionId: current.transaction.transactionId, decision: 'skip', reason: 'Synthetic recall test has enough context.' }, { actor: f.actor }); await f.engine.flush();
  current = await f.store.loadJob(job.jobId); assert.equal(current.state, 'awaiting_reload');
  for (const s of current.reload.sources) await f.files.read(s.path);
  await f.engine.ackReload({ jobId: job.jobId, transactionId: current.transaction.transactionId, readSourceIds: current.reload.sources.map(s => s.sourceId) }, { actor: f.actor }); await f.engine.flush();
  return f.store.loadJob(job.jobId);
}

test('blocked dream cannot block factual review, commit, reload, status or engine flush', async t => {
  const entered = deferred(), release = deferred(); const f = await fixture(t, { writer: async () => { entered.resolve(); await release.promise; return output; } });
  t.after(() => release.resolve());
  const job = await f.engine.dream(); await entered.promise; assert.equal(job.state, 'awaiting_review');
  const before = await f.engine.status({ jobId: job.jobId }); assert.equal(before.narrative.state, 'generating'); assert.equal(before.episodes.episodes[0].category, 'relationship');
  const done = await commitAndReload(f, job); assert.equal(done.state, 'completed');
  assert.equal((await f.engine.status({ jobId: job.jobId })).narrative.state, 'generating');
  assert.equal((await f.files.read(join(f.config.memoryRoot, 'long-term.md'))).content, '# Synthetic memory\n- Synthetic: The red mug was a gift from River.\n');
  assert.equal(f.calls.models.length, 2); assert.equal(f.calls.writtenDream, 0);
  release.resolve(); await f.tasks.flush(); assert.equal((await f.engine.status({ jobId: job.jobId })).narrative.state, 'completed');
});

test('dream disabled still completes the exact same factual consolidation without history or dream calls', async t => {
  const f = await fixture(t, { mode: 'off', writer: async () => { throw new Error('Must not call dream'); } }); const job = await f.engine.dream();
  const done = await commitAndReload(f, job); await f.tasks.flush();
  assert.equal(done.state, 'completed'); assert.equal(f.calls.context, 0); assert.equal(f.calls.writtenDream, 0); assert.equal(f.calls.models.length, 2); assert.equal((await f.tasks.status(job.jobId)).state, 'disabled');
});

test('corrupt independent dream records cannot block factual status or recovery', async t => {
  const f = await fixture(t, { mode: 'off' }); const job = await f.engine.dream(); await f.tasks.flush();
  const path = join(f.config.stateRoot, 'dream-tasks', `${encodeURIComponent(job.jobId)}.json`); const old = await f.files.read(path);
  await f.files.write(path, '{corrupt', old.version);
  const status = await f.engine.status({ jobId: job.jobId }); assert.equal(status.narrative.state, 'unavailable'); assert.equal(status.state, 'awaiting_review');
  await f.engine.resume(); await f.tasks.flush(); const done = await commitAndReload(f, job); assert.equal(done.state, 'completed');
});

test('engine recall can read older current daily bytes without widening consolidation collection or claiming current plan completion', async t => {
  const f = await fixture(t, { mode: 'off' });
  const path = join(f.config.memoryRoot, 'daily/2026-10-20.md');
  await f.files.write(path, 'Synthetic old note: The violet ticket should be checked Friday evening; the exact hour is not set.\n', null);
  const result = await f.engine.recall({ query: 'violet ticket Friday', topic: 'synthetic travel', conditions: 'Historical plan only' });
  assert.ok(result.hits.some(h => h.sourceId === 'daily/2026-10-20.md' && h.text.includes('exact hour is not set')));
  assert.ok(result.hits.filter(h => h.sourceId === 'daily/2026-10-20.md').every(h => h.temporalStatus === 'dated-record-not-current-status'));
  assert.equal(result.coverage.materials.dailyFilesRead, 1);
  // A live reread must not revive a stale phrase from any saved job or old recall.
  const previous = await f.files.read(path); await f.files.write(path, 'Synthetic corrected note: The violet ticket was cancelled, not checked.\n', previous.version);
  const changed = await f.engine.recall({ query: 'violet ticket', topic: 'synthetic travel', conditions: 'Historical plan only' });
  assert.ok(changed.hits.some(h => h.text.includes('cancelled'))); assert.equal(changed.hits.some(h => h.text.includes('Friday evening')), false);
});

test('identical historical and current source bytes do not create mismatched derived provenance in recall', async t => {
  const f = await fixture(t, { mode: 'off' }); const original = await f.files.read(join(f.config.memoryRoot, 'long-term.md'));
  await f.files.write(join(f.config.memoryRoot, 'daily/2026-10-20.md'), original.content, null);
  const result = await f.engine.recall({ query: 'Synthetic memory', topic: 'fixture', conditions: 'Any recorded wording' });
  assert.ok(result.hits.length > 0); assert.equal(result.coverage.materials.dailyFilesRead, 1);
});

test('failed dream is reported independently and ordinary resume never rerolls it or rewrites memory', async t => {
  const f = await fixture(t, { writer: async () => { throw new Error('Synthetic dream provider failed'); } }); const job = await f.engine.dream(); await f.tasks.flush();
  assert.equal((await f.tasks.status(job.jobId)).state, 'failed'); assert.equal(job.state, 'awaiting_review');
  await commitAndReload(f, job); const before = await f.files.read(join(f.config.memoryRoot, 'long-term.md')); await f.engine.resume(); await f.tasks.flush(); await f.engine.flush();
  assert.deepEqual(await f.files.read(join(f.config.memoryRoot, 'long-term.md')), before); assert.equal(f.calls.models.length, 2); assert.equal((await f.tasks.status(job.jobId)).attempts, 1);
  const snapshot = await f.store.loadGenerationSnapshot(job.jobId); assert.equal(snapshot.snapshotId, (await f.store.loadDreamResult(job.jobId)).digest.snapshotId);
});
