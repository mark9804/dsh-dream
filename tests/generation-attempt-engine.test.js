import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createStore } from '../dist/storage/index.js';
import { createEngine } from '../dist/engine.js';
import { validateConfig } from '../dist/config.js';
import { createQuoteValidationIssue, formatQuoteValidationIssue } from '../dist/domain/quote-diagnostics.js';

const at = '2026-11-09T05:30:00Z';
const id = '12345678-1234-4123-8123-123456789abc';
const scope = { scopeId: 'synthetic', agentId: 'synthetic', sessionId: 'synthetic', memoryRootId: '/synthetic/memory' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture({ archiveFailure = false, pauseArchive } = {}) {
  const records = new Map(), notices = [], writes = []; let revision = 0, tail = Promise.resolve();
  const files = {
    async read(path) { return records.get(path) ?? null; }, async mkdir() {}, async stat() { return null; },
    async list(path) { return [...records.keys()].filter(p => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/')).map(p => ({ name: p.slice(path.length + 1), isDirectory: false })); },
    async write(path, content, version) {
      if (path.includes('/attempts/')) {
        if (pauseArchive) await pauseArchive(path);
        if (archiveFailure) throw Object.assign(new Error('SYNTHETIC_RAW_FILESYSTEM_PRIVATE'), { code: 'FS_DENIED' });
      }
      assert.equal(records.get(path)?.version ?? null, version); records.set(path, { content, version: ++revision }); writes.push(path); return revision;
    },
    withLock(_key, work) { const task = tail.then(work); tail = task.catch(() => {}); return task; },
  };
  const source = { sourceId: 'journal.md', path: 'journal.md', role: 'journal', content: 'SYNTHETIC_NEAREST_CANARY: The river was blue.', version: 1, writable: false, sensitivity: 'private', protectedText: [] };
  records.set('/synthetic/memory/journal.md', { content: source.content, version: source.version });
  const snapshot = { schemaVersion: 1, snapshotId: 'old-snapshot', scope, capturedAt: at, sources: [source] };
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, state: 'failed', phase: 'generating', checkpoint: { state: 'generating' }, error: { code: 'FAILED', message: 'old failure' }, proposals: [], reviews: [], appliedProposalIds: [], createdAt: at, updatedAt: at };
  const config = validateConfig({ sessionId: scope.sessionId, memoryRoot: scope.memoryRootId, stateRoot: '/synthetic/state', timeZone: 'UTC', dreamMode: 'off' });
  const store = createStore(files, { root: config.stateRoot, lockKey: scope.memoryRootId }); await store.saveJob(job);
  let generated = 0, archived;
  const generate = async (current, jobId, options) => {
    generated++;
    await options.onDiagnostic({ schemaVersion: 1, attemptId: id, snapshotId: current.snapshotId, mode: 'memory-v2', state: 'running', stage: 'organize', startedAt: at, updatedAt: at, elapsedMs: 0, timeoutMs: 1000,
      input: { sourceCount: 1, contentBytes: source.content.length, serializedSourceBytes: JSON.stringify(current.sources).length }, stages: [{ stage: 'organize', startedAt: at, elapsedMs: 0 }], calls: [] });
    const issue = createQuoteValidationIssue({ episodeIndex: 0, evidenceIndex: 0, episodeId: 'synthetic-episode', sourceId: source.sourceId, source: current.sources[0], quote: 'SYNTHETIC_QUOTE_CANARY: The river was green.' });
    const text = '{"synthetic":"SYNTHETIC_OUTPUT_CANARY"}';
    archived = { schemaVersion: 1, attemptId: id, jobId, snapshotId: current.snapshotId, scope, mode: 'memory-v2', startedAt: at, failedAt: at, stage: 'organize',
      outputs: [{ sequence: 1, stage: 'organize', text, bytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated: false, sha256: createHash('sha256').update(text).digest('hex') }],
      validation: { code: 'GENERATION_VALIDATION_FAILED', message: formatQuoteValidationIssue(issue), issue }, private: true, untrusted: true };
    await options.onValidationFailure(archived);
    throw Object.assign(new Error(archived.validation.message), { code: 'GENERATION_VALIDATION_FAILED', validationIssue: issue, attemptId: id });
  };
  const host = { async waitForIdle() {}, async notify(message) { notices.push(message); }, async requestReview() { assert.fail('invalid generation cannot request approval'); } };
  let serial = 0; const options = { config, scope, files, store, generate, host, now: () => new Date(at), id: () => `synthetic-id-${++serial}` };
  const engine = createEngine(options);
  return { engine, store, notices, writes, records, options, generated: () => generated, archived: () => archived };
}

test('failed validation archives exact output, persists private details and keeps attention content-free across restart', async () => {
  const f = await fixture(); await f.engine.retry({ jobId: 'job' }); await f.engine.flush();
  const job = await f.store.loadJob('job');
  assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'GENERATION_VALIDATION_FAILED');
  assert.match(job.error.message, /SYNTHETIC_QUOTE_CANARY/);
  assert.equal(job.error.details.archiveState, 'saved'); assert.equal(job.error.details.attemptId, id);
  assert.deepEqual(await f.store.loadGenerationAttempt(id, scope), f.archived());
  assert.match(f.records.get(job.error.details.attemptPath).content, /SYNTHETIC_OUTPUT_CANARY/);
  assert.equal(f.generated(), 1); assert.deepEqual(job.reviews, []); assert.deepEqual(job.proposals, []);
  assert.ok(f.writes.every(path => !path.startsWith(scope.memoryRootId + '/')));
  assert.doesNotMatch(JSON.stringify(f.notices), /SYNTHETIC_QUOTE_CANARY|SYNTHETIC_NEAREST_CANARY|SYNTHETIC_OUTPUT_CANARY/);
  assert.match(f.notices[0], new RegExp(id));
  const restarted = createEngine(f.options);
  assert.deepEqual((await restarted.status({ jobId: 'job' })).error, job.error);
  assert.doesNotMatch(JSON.stringify(job.generationDiagnostics), /CANARY/);
});

test('archive write failure gets dedicated code and keeps issue without claiming a saved path or leaking storage errors', async () => {
  const f = await fixture({ archiveFailure: true }); await f.engine.retry({ jobId: 'job' }); await f.engine.flush();
  const job = await f.store.loadJob('job');
  assert.equal(job.error.code, 'GENERATION_ATTEMPT_SAVE_FAILED');
  assert.equal(job.error.details.archiveState, 'failed'); assert.equal(job.error.details.archiveErrorCode, 'FS_DENIED');
  assert.equal(job.error.details.attemptPath, undefined); assert.match(job.error.details.validationIssue.quote, /SYNTHETIC_QUOTE_CANARY/);
  assert.equal(await f.store.loadGenerationAttempt(id, scope), null);
  assert.doesNotMatch(JSON.stringify(f.notices), /CANARY|PRIVATE/);
  assert.doesNotMatch(job.error.message, /PRIVATE/);
  assert.deepEqual(job.reviews, []); assert.deepEqual(job.proposals, []);
});

test('already-started private archive remains part of engine flush until real write settlement', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ pauseArchive: async () => { entered.resolve(); await release.promise; } });
  await f.engine.retry({ jobId: 'job' }); await entered.promise;
  let done = false; const flushing = f.engine.flush().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  release.resolve(); await flushing;
  assert.equal((await f.store.loadJob('job')).error.details.archiveState, 'saved');
});
