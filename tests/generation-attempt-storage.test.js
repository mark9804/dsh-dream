import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createStore } from '../dist/storage/index.js';
import { validateGenerationAttempt, MAX_ATTEMPT_RETAINED_BYTES } from '../dist/domain/generation-attempt.js';

const id = '12345678-1234-4123-8123-123456789abc';
const scope = { scopeId: 'synthetic', agentId: 'synthetic', sessionId: 'synthetic', memoryRootId: '/synthetic/memory' };
const at = '2026-11-09T05:00:00Z';
function attempt(text = 'SYNTHETIC_PRIVATE_OUTPUT') {
  return { schemaVersion: 1, attemptId: id, jobId: 'job', snapshotId: 'snapshot', scope, mode: 'memory-v2', startedAt: at, failedAt: at, stage: 'organize',
    outputs: [{ sequence: 1, stage: 'organize', text, bytes: Buffer.byteLength(text), retainedBytes: Buffer.byteLength(text), truncated: false, sha256: createHash('sha256').update(text).digest('hex') }],
    validation: { code: 'GENERATION_VALIDATION_FAILED', message: 'Synthetic invalid quote' }, private: true, untrusted: true };
}
function fixture() {
  const records = new Map(); const writes = []; let version = 0, tail = Promise.resolve();
  const files = { async read(path, options) { const found = records.get(path); if (found && options?.maxBytes < Buffer.byteLength(found.content)) throw Error('read limit'); return found ?? null; },
    async write(path, content, expected) { assert.equal(records.get(path)?.version ?? null, expected); records.set(path, { content, version: ++version }); writes.push(path); return version; },
    async mkdir() {}, async list() { return []; }, async stat() { return null; },
    withLock(_key, work) { const task = tail.then(work); tail = task.catch(() => {}); return task; } };
  const store = createStore(files, { root: '/synthetic/state', lockKey: scope.memoryRootId });
  const snapshot = { schemaVersion: 1, snapshotId: 'snapshot', scope, capturedAt: at, sources: [] };
  const diagnostic = { schemaVersion: 1, attemptId: id, snapshotId: 'snapshot', mode: 'memory-v2', state: 'failed', stage: 'organize', startedAt: at, updatedAt: at, elapsedMs: 0, timeoutMs: 1000,
    input: { sourceCount: 0, contentBytes: 0, serializedSourceBytes: 2 }, stages: [{ stage: 'organize', startedAt: at, elapsedMs: 0 }], calls: [] };
  const job = { schemaVersion: 1, jobId: 'job', scope, snapshot, generationDiagnostics: diagnostic, state: 'generating', proposals: [], reviews: [], appliedProposalIds: [], createdAt: at, updatedAt: at };
  return { store, records, writes, job };
}

test('attempt schema preserves original text and verifies hashes, sizes and private-only fields', () => {
  const good = attempt('Synthetic\n中文\u0000 output'); assert.equal(validateGenerationAttempt(good), good);
  for (const mutate of [a => { a.prompt = 'forbidden'; }, a => { a.outputs[0].reasoning = 'forbidden'; }, a => { a.private = false; },
    a => { a.outputs[0].bytes++; }, a => { a.outputs[0].retainedBytes++; }, a => { a.outputs[0].sha256 = 'f'.repeat(64); },
    a => { a.failedAt = '2026-11-08T05:00:00Z'; }, a => { a.attemptId = '../escape'; }, a => { a.scope = {}; },
    a => { a.outputs = Array.from({ length: 5 }, (_, i) => ({ ...a.outputs[0], sequence: i + 1 })); }]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => validateGenerationAttempt(bad));
  }
  const truncated = attempt('retained prefix'); truncated.outputs[0].bytes += 100; truncated.outputs[0].truncated = true; truncated.outputs[0].sha256 = 'f'.repeat(64);
  assert.equal(validateGenerationAttempt(truncated), truncated);
  assert.throws(() => validateGenerationAttempt(attempt('x'.repeat(MAX_ATTEMPT_RETAINED_BYTES + 1))));
});

test('archive saves immutable bytes once, supports idempotent repeats and explicit scope verification', async () => {
  const f = fixture(); await f.store.saveJob(f.job);
  const input = attempt(); const path = await f.store.saveGenerationAttempt(input);
  assert.equal(path, `/synthetic/state/attempts/${id}.json`);
  assert.equal(await f.store.saveGenerationAttempt(structuredClone(input)), path);
  assert.equal(f.writes.filter(p => p === path).length, 1);
  assert.deepEqual(await f.store.loadGenerationAttempt(id, scope), input);
  await assert.rejects(f.store.loadGenerationAttempt(id, { ...scope, agentId: 'foreign' }), /scope mismatch/);
  await assert.rejects(f.store.saveGenerationAttempt(attempt('different output')), error => error.code === 'GENERATION_ATTEMPT_CONFLICT');
  assert.deepEqual(await f.store.loadGenerationAttempt(id), input);
});

test('new archive requires exact live generation owner while existing identical archive remains readable after failure', async () => {
  const f = fixture(); await f.store.saveJob(f.job);
  for (const changed of [{ jobId: 'other' }, { snapshotId: 'other' }, { mode: 'legacy' }, { attemptId: '22345678-1234-4123-8123-123456789abc' }, { scope: { ...scope, agentId: 'other' } }]) {
    await assert.rejects(f.store.saveGenerationAttempt({ ...attempt(), ...changed }), error => error.code === 'GENERATION_ATTEMPT_CONFLICT');
  }
  const saved = await f.store.saveGenerationAttempt(attempt());
  await f.store.updateJob('job', job => ({ ...job, state: 'failed', phase: 'generating', checkpoint: { state: 'generating' } }));
  assert.equal(await f.store.saveGenerationAttempt(attempt()), saved);
  assert.equal(f.writes.filter(p => p.includes('/attempts/')).length, 1);
});

test('archive detaches before lock waiting and concurrent equal attempts never overwrite', async () => {
  const f = fixture(); await f.store.saveJob(f.job);
  const input = attempt(); const first = f.store.saveGenerationAttempt(input);
  input.outputs[0].text = 'mutation after invocation';
  const second = f.store.saveGenerationAttempt(attempt());
  assert.deepEqual(await Promise.all([first, second]), [`/synthetic/state/attempts/${id}.json`, `/synthetic/state/attempts/${id}.json`]);
  assert.deepEqual(await f.store.loadGenerationAttempt(id), attempt());
  assert.equal(f.writes.filter(p => p.includes('/attempts/')).length, 1);
});
