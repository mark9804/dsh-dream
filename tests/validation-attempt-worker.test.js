import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
import { validateGenerationAttempt, MAX_ATTEMPT_RETAINED_BYTES } from '../dist/domain/generation-attempt.js';
import { validateGenerationDiagnostics } from '../dist/domain/generation-diagnostics.js';
const source = { sourceId: 'journal', path: 'journal.md', role: 'journal', content: 'SYNTHETIC_SOURCE_ONLY. The bird sat on the blue bowl.', version: 1, writable: false, sensitivity: 'private', protectedText: [] };
const snapshot = { schemaVersion: 1, snapshotId: 'synthetic-attempt-snapshot', capturedAt: '2026-11-09T00:00:00Z', scope: { scopeId: 'synthetic', agentId: 'synthetic', sessionId: 'synthetic', memoryRootId: '/synthetic' }, sources: [source] };
const limits = { timeoutMs: 10000, maxOutputBytes: 65536, maxProposals: 2, maxEpisodes: 2 };
const invalidEpisode = JSON.stringify({ episodes: [{ summary: 'Bird', when: 'unknown', participants: [], status: 'reported', category: 'relationship', importanceReason: 'synthetic', retention: 'recent', evidence: [{ sourceId: 'journal', quote: 'SYNTHETIC_BAD_QUOTE. The bird sat on the green bowl.' }] }], coveredSourceIds: ['journal'] });
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
test('worker quote failure archives Host-retained original text, exact attempt identity and bounded same-source details', async () => {
  const attempts = [], diagnostics = [];
  await assert.rejects(createWorkerGenerator(async () => invalidEpisode, limits, 'memory-v2')(snapshot, 'job', { onDiagnostic: d => diagnostics.push(d), onValidationFailure: a => attempts.push(a) }), error => {
    assert.equal(error.code, 'GENERATION_VALIDATION_FAILED'); assert.match(error.message, /SYNTHETIC_BAD_QUOTE/);
    assert.equal(error.validationIssue.episodeIndex, 0); assert.equal(error.validationIssue.evidenceIndex, 0); return true;
  });
  assert.equal(attempts.length, 1); const a = validateGenerationAttempt(attempts[0]);
  assert.equal(a.outputs[0].text, invalidEpisode); assert.equal(a.outputs[0].truncated, false); assert.equal(a.stage, 'organize');
  assert.equal(a.attemptId, diagnostics.at(-1).attemptId); assert.equal(a.validation.issue.sourcePath, 'journal.md');
  assert.equal(source.content.slice(a.validation.issue.nearest.start, a.validation.issue.nearest.end), a.validation.issue.nearest.text);
  assert.ok(a.validation.issue.nearest.similarity >= 0 && a.validation.issue.nearest.similarity <= 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /SYNTHETIC_BAD_QUOTE|SYNTHETIC_SOURCE_ONLY|green bowl/);
  validateGenerationDiagnostics(diagnostics.at(-1)); assert.ok(diagnostics.at(-1).settledAt);
});
test('invalid JSON and DEEP output validation retain successful stage outputs but provider failures do not', async () => {
  for (const mode of ['json', 'deep', 'provider']) {
    const attempts = []; let n = 0;
    const model = async () => { n++; if (mode === 'provider') throw Object.assign(new Error('SYNTHETIC_PROVIDER_PRIVATE'), { code: 'PROVIDER_FAILED' }); if (mode === 'json') return '{SYNTHETIC_INVALID_JSON'; return n === 1 ? JSON.stringify({ episodes: [], coveredSourceIds: ['journal'] }) : '{"proposals":"INVALID"}'; };
    await assert.rejects(createWorkerGenerator(model, limits, 'memory-v2')(snapshot, 'job', { onValidationFailure: a => attempts.push(a) }));
    if (mode === 'provider') assert.deepEqual(attempts, []); else { assert.equal(attempts.length, 1); assert.equal(attempts[0].outputs.length, mode === 'json' ? 1 : 2); assert.equal(attempts[0].validation.issue, undefined); }
  }
});
test('provider reuse of a reserved validation code never masquerades as local validation', async () => {
  const attempts = []; let n = 0;
  const model = async () => { if (++n === 1) return '{"episodes":[],"coveredSourceIds":["journal"]}'; throw Object.assign(new Error('SYNTHETIC_PROVIDER_PRIVATE'), { code: 'GENERATION_VALIDATION_FAILED' }); };
  await assert.rejects(createWorkerGenerator(model, limits, 'memory-v2')(snapshot, 'job', { onValidationFailure: a => attempts.push(a) }), error => error.code === 'MODEL_FAILED');
  assert.deepEqual(attempts, []);
});
test('private archive callback failure is distinct and callback drainage is awaited', async () => {
  const entered = deferred(), release = deferred(); let done = false;
  const pending = createWorkerGenerator(async () => invalidEpisode, limits, 'memory-v2')(snapshot, 'job', { async onValidationFailure() { entered.resolve(); await release.promise; throw new Error('SYNTHETIC_PRIVATE_STORAGE'); } });
  pending.catch(() => { done = true; }); await entered.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  release.resolve(); await assert.rejects(pending, error => error.code === 'GENERATION_ATTEMPT_SAVE_FAILED' && !error.message.includes('SYNTHETIC_PRIVATE_STORAGE'));
});
test('oversized successful text has explicit retention truncation and intact hash metadata, never unbounded archives', async () => {
  const huge = '界'.repeat(MAX_ATTEMPT_RETAINED_BYTES), attempts = [];
  await assert.rejects(createWorkerGenerator(async () => huge, limits, 'memory-v2')(snapshot, 'job', { onValidationFailure: a => attempts.push(a) }));
  const a = validateGenerationAttempt(attempts[0]); assert.equal(a.outputs[0].bytes, Buffer.byteLength(huge)); assert.equal(a.outputs[0].truncated, true);
  assert.ok(a.outputs[0].retainedBytes <= MAX_ATTEMPT_RETAINED_BYTES); assert.equal(Buffer.byteLength(a.outputs[0].text), a.outputs[0].retainedBytes); assert.equal(a.outputs[0].text.endsWith('界'), true);
});
test('successful generation and cancellation never create validation-failure archives', async () => {
  const attempts = []; let n = 0;
  await createWorkerGenerator(async () => ++n === 1 ? '{"episodes":[],"coveredSourceIds":["journal"]}' : '{"proposals":[]}', limits, 'memory-v2')(snapshot, 'job', { onValidationFailure: a => attempts.push(a) });
  const stop = new AbortController(); stop.abort(new Error('explicit abort'));
  await assert.rejects(createWorkerGenerator(async () => assert.fail('no dispatch'), limits, 'memory-v2')(snapshot, 'job', { signal: stop.signal, onValidationFailure: a => attempts.push(a) }), /explicit abort/);
  assert.deepEqual(attempts, []);
});
