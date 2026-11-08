import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJob } from '../dist/domain/contracts.js';
import { validateConfig } from '../dist/config.js';
import { createLocalFiles } from '../dist/storage/local-files.js';
import { createStore } from '../dist/storage/index.js';
import { createEngine } from '../dist/engine.js';
import { createHostModel } from '../dist/harness/model.js';
import { createWorkerGenerator } from '../dist/scheduler/executor.js';
const project = await realpath(fileURLToPath(new URL('..', import.meta.url)));
assert.ok(process.argv[2], 'Pass the authorized private copy root');
const root = await realpath(resolve(process.argv[2])), part = relative(join(project, 'tests/.tmp'), root);
assert.ok(part && part !== '..' && !part.startsWith('../') && !isAbsolute(part));
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.privateCopy, true); assert.equal(manifest.root, root);
const original = validateJob(JSON.parse(await readFile(join(root, 'original/job.json'), 'utf8')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function verifyOriginals() { for (const entry of manifest.originals) assert.equal(sha(await readFile(entry.path)), entry.sha256, 'Original input or installed configuration changed'); }
await verifyOriginals();
const copyHashes = [];
for (const source of original.snapshot.sources) { const p = source.role === 'persona' ? join(root, 'persona.md') : join(root, 'memory', source.path); copyHashes.push([p, sha(await readFile(p))]); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const runRoot = await mkdtemp(join(root, 'verification-run-'));
const base = createLocalFiles(root), local = p => isAbsolute(p) ? relative(root, p) : p;
function checked(p) { const path = local(p); assert.ok(path && path !== '..' && !path.startsWith('../') && !isAbsolute(path)); return path; }
const files = { ...base, read: (p, o) => base.read(checked(p), o), write: (p, c, v) => base.write(checked(p), c, v), mkdir: p => base.mkdir(checked(p)), stat: p => base.stat(checked(p)), list: p => base.list(checked(p)) };
async function run(name, timeoutMs, simulateTimeout) {
  const stateRoot = join(runRoot, name, 'state'); await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const config = validateConfig({ sessionId: 'isolated-copy-session', memoryRoot: join(root, 'memory'), stateRoot, personaPath: join(root, 'persona.md'), timeoutMs, dreamMode: 'off', compactionMode: 'manual', singleRun: true, timeZone: 'Asia/Tokyo' });
  const scope = { scopeId: name, agentId: config.sessionId, sessionId: config.sessionId, memoryRootId: config.memoryRoot };
  const job = structuredClone(original); job.scope = scope; job.snapshot.scope = scope;
  job.snapshot.snapshotId = `${name}-snapshot`; delete job.attentionDelivery; delete job.inputFingerprint;
  const store = createStore(files, { root: stateRoot, lockKey: stateRoot }); await store.saveJob(job);
  const stageOne = deferred(), firstRelease = deferred(), stageTwo = deferred(), secondRelease = deferred(), timedOut = deferred();
  let calls = 0; const diagnostics = [];
  // Strictly in-memory adapter. No imported Host runtime, fetch, credentials or provider endpoint.
  const agent = { id: config.sessionId, session: { id: config.sessionId }, options: { provider: 'isolated-mock', model: 'non-network-fixture' } };
  const model = createHostModel({ llm: { async prepareCall(callConfig) { return { config: callConfig, async *stream(input) {
    calls++; const prompt = input.messages[0].content[0].text;
    if (calls === 1) { assert.ok(prompt.startsWith('ORGANIZE：')); stageOne.resolve(); await firstRelease.promise; }
    else { assert.ok(prompt.includes('\nDEEP：')); input.signal.addEventListener('abort', () => timedOut.resolve(), { once: true }); stageTwo.resolve(); await secondRelease.promise; }
    input.signal.throwIfAborted();
    yield { type: 'reasoning-delta', index: 0, text: 'SIMULATED_PROGRESS_ONLY' };
    yield { type: 'text-delta', index: 1, text: JSON.stringify(calls === 1 ? { episodes: [], coveredSourceIds: original.snapshot.sources.map(s => s.sourceId) } : { proposals: [] }) };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } } }, agent);
  const rawGenerate = createWorkerGenerator(model, config, 'memory-v2');
  const generate = (snapshot, jobId, options) => rawGenerate(snapshot, jobId, { ...options, async onDiagnostic(value) { diagnostics.push(value); await options.onDiagnostic(value); } });
  const host = { async waitForIdle() {}, async notify() {}, async requestReview() { assert.fail('No proposals or review expected'); }, async requestReload() { assert.fail('No memory writes expected'); }, async compact() { assert.fail('No compression expected'); } };
  let count = 0; const engine = createEngine({ config, scope, files, store, generate, host, id: () => `${name}-${++count}`, now: () => new Date('2026-11-08T05:30:00+09:00') });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await engine.retry({ jobId: job.jobId }); await stageOne.promise;
    mock.timers.tick(180000); firstRelease.resolve(); await stageTwo.promise;
    const live = await store.loadJob(job.jobId); assert.equal(live.generationDiagnostics.stage, 'deep');
    assert.equal(live.generationDiagnostics.calls[0].state, 'completed'); assert.equal(live.generationDiagnostics.calls[1].state, 'streaming');
    mock.timers.tick(180000);
    if (simulateTimeout) { await timedOut.promise; await new Promise(setImmediate); } else assert.equal(diagnostics.at(-1).state, 'running');
    secondRelease.resolve(); await engine.flush();
  } finally { firstRelease.resolve(); secondRelease.resolve(); mock.timers.reset(); await engine.flush(); }
  const final = await store.loadJob(job.jobId), d = final.generationDiagnostics;
  assert.equal(final.state, simulateTimeout ? 'failed' : 'reviewed_no_changes'); assert.equal(d.state, simulateTimeout ? 'timed_out' : 'completed');
  if (simulateTimeout) { assert.equal(final.error.code, 'DREAM_EXECUTOR_TIMEOUT'); assert.equal(d.stage, 'deep'); }
  assert.ok(d.settledAt); assert.equal(calls, 2); assert.equal(final.appliedProposalIds.length, 0);
  const encoded = JSON.stringify(d);
  for (const source of original.snapshot.sources) { assert.ok(!encoded.includes(source.content)); assert.ok(!encoded.includes(source.content.slice(0, Math.min(24, source.content.length)))); }
  assert.ok(!encoded.includes('SIMULATED_PROGRESS_ONLY'));
  return { name, budgetMinutes: timeoutMs / 60000, simulatedStageDurationMinutes: 3, simulatedTotalMinutes: 6,
    state: final.state, diagnosticState: d.state, stageAtFinish: d.stage, callStates: d.calls.map(c => c.state), actualSettlementRecorded: !!d.settledAt, errorCode: final.error?.code,
    onlyMockCalls: calls, sourceCount: d.input.sourceCount, noAppliedChanges: final.appliedProposalIds.length === 0, contentFreeDiagnostics: true };
}
const short = await run('five-minute-control', 300000, true), extended = await run('fifteen-minute-default', 900000, false);
for (const [p, expected] of copyHashes) assert.equal(sha(await readFile(p)), expected, 'Copied memory bytes changed');
await verifyOriginals();
const report = { state: 'completed', sourceJobId: original.jobId, sourceCount: manifest.sourceCount, controls: [short, extended],
  originalInputsAndConfigPreserved: true, copiedMemoryPreserved: true, externalModelCalls: 0, paidCalls: 0,
  simulationOnly: true, acceleratedDeadline: true, wallClockStageLatencyMeasured: false, noPluginInstallation: true, noLiveTaskRetry: true, noRealMemoryWrites: true };
await writeFile(join(runRoot, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...report, reportPath: join(runRoot, 'verification.json') }, null, 2));
