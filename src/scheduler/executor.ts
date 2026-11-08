import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Model, DreamConfig, Generate, DreamResult } from '../types.js';
import { errorFields } from '../types.js';
import { diagnosticCode, validateGenerationDiagnostics, validateModelProgress } from '../domain/generation-diagnostics.js';
import type { GenerationDiagnostics, GenerationStage, GenerationCall, ModelProgress } from '../domain/generation-diagnostics.js';
type WorkerMessage = { type: 'result'; result: DreamResult; threadId: number } | { type: 'failure'; error: string; code?: string } | { type: 'model'; id: number; prompt: string } | { type: 'stage'; stage: GenerationStage };

/** Run orchestration in its own event loop; model authority stays in Host.
 * Cancellation stops dispatch immediately; settlement waits for actual Worker
 * exit, every started model call and diagnostic persistence. No forced-drain lie. */
export function createWorkerGenerator(model: Model, limits: Pick<DreamConfig, 'timeoutMs' | 'maxOutputBytes' | 'maxProposals'> & Partial<Pick<DreamConfig, 'maxEpisodes'>>, mode: 'legacy' | 'memory-v2' = 'legacy'): Generate {
  return (snapshot, jobId, { signal, onDiagnostic } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || limits.timeoutMs > 2147483647) { reject(new RangeError('Invalid executor timeoutMs')); return; }
    const capturedModel = model.capture?.() ?? model;
    const controller = new AbortController();
    const clock = () => new Date().toISOString();
    const started = performance.now(), startedAt = clock();
    const diagnostic: GenerationDiagnostics = { schemaVersion: 1, attemptId: randomUUID(), snapshotId: snapshot.snapshotId, mode,
      state: 'running', stage: 'starting', startedAt, updatedAt: startedAt, elapsedMs: 0, timeoutMs: limits.timeoutMs,
      input: { sourceCount: snapshot.sources.length, contentBytes: snapshot.sources.reduce((n, source) => n + Buffer.byteLength(source.content), 0), serializedSourceBytes: Buffer.byteLength(JSON.stringify(snapshot.sources)) },
      stages: [{ stage: 'starting', startedAt, elapsedMs: 0 }], calls: [] };
    validateGenerationDiagnostics(diagnostic);
    const worker = new Worker(new URL(mode === 'memory-v2' ? '../dream/memory-worker.js' : '../dream/worker.js', import.meta.url), {
      workerData: { snapshot, jobId, limits: { maxOutputBytes: limits.maxOutputBytes, maxProposals: limits.maxProposals, maxEpisodes: limits.maxEpisodes ?? 32 } },
    });
    const calls = new Set<Promise<void>>();
    let stopping = false, exited!: () => void, currentCall: GenerationCall | undefined;
    let lastHeartbeat = performance.now(), persistenceError: unknown, heartbeatPending = false;
    let persisted: Promise<void> = Promise.resolve();
    const workerExited = new Promise<void>(done => { exited = done; });
    const elapsed = () => Math.max(0, Math.round(performance.now() - started));
    function refresh() {
      diagnostic.updatedAt = clock(); diagnostic.elapsedMs = elapsed();
      const stage = diagnostic.stages.at(-1)!;
      if (!stage.finishedAt) stage.elapsedMs = Math.max(0, Date.parse(diagnostic.updatedAt) - Date.parse(stage.startedAt));
      if (currentCall && !currentCall.finishedAt) { currentCall.updatedAt = diagnostic.updatedAt; currentCall.elapsedMs = Math.max(0, Date.parse(currentCall.updatedAt) - Date.parse(currentCall.startedAt)); }
    }
    function publish(): Promise<void> {
      refresh();
      if (!onDiagnostic) return Promise.resolve();
      const value = structuredClone(validateGenerationDiagnostics(diagnostic));
      const work = persisted.then(async () => { if (!persistenceError) await onDiagnostic(value); });
      persisted = work.catch(() => { persistenceError ??= Object.assign(new Error('Generation diagnostic persistence failed'), { code: 'GENERATION_DIAGNOSTIC_FAILED' }); if (!stopping) finish(persistenceError); });
      return work;
    }
    function setStage(stage: GenerationStage) {
      if (diagnostic.stage === stage) return;
      if (!['organize', 'deep', 'validation', 'legacy'].includes(stage) || diagnostic.stages.length >= 8) throw new TypeError('Invalid generation stage');
      refresh(); const previous = diagnostic.stages.at(-1)!; previous.finishedAt = diagnostic.updatedAt;
      diagnostic.stage = stage; diagnostic.stages.push({ stage, startedAt: diagnostic.updatedAt, elapsedMs: 0 });
      void publish().catch(() => {});
    }
    function finish(error: unknown, result?: DreamResult) {
      if (stopping) return;
      stopping = true; clearTimeout(timer); clearInterval(heartbeat); signal?.removeEventListener('abort', abort);
      refresh(); diagnostic.finishedAt = diagnostic.updatedAt;
      diagnostic.failureCode = error ? diagnosticCode(errorFields(error).code, signal?.aborted ? 'GENERATION_CANCELLED' : 'GENERATION_FAILED') : undefined;
      diagnostic.state = !error ? 'completed' : diagnostic.failureCode === 'DREAM_EXECUTOR_TIMEOUT' ? 'timed_out' : signal?.aborted ? 'cancelled' : 'failed';
      const stage = diagnostic.stages.at(-1)!; stage.finishedAt ??= diagnostic.updatedAt;
      if (currentCall && !currentCall.finishedAt) {
        currentCall.state = error ? signal?.aborted || diagnostic.state === 'timed_out' ? 'cancelled' : 'failed' : 'completed'; currentCall.finishedAt = diagnostic.updatedAt;
        if (error) currentCall.failureCode ??= diagnostic.failureCode;
      }
      controller.abort(error ?? new Error('Dream executor finished'));
      void publish().catch(() => {});
      const termination = Promise.resolve().then(() => worker.terminate());
      void Promise.allSettled([termination, workerExited, ...calls]).then(async outcomes => {
        diagnostic.settledAt = clock(); await publish().catch(() => {}); await persisted;
        const cleanupFailure = outcomes.find(outcome => outcome.status === 'rejected');
        if (error) reject(error);
        else if (persistenceError) reject(persistenceError);
        else if (cleanupFailure) reject(cleanupFailure.reason);
        else resolve(result!);
      }).catch(reject);
    }
    const abort = () => finish(signal!.reason ?? new Error('Dream cancelled'));
    const timer = setTimeout(() => finish(Object.assign(new Error(`Dream executor timed out during ${diagnostic.stage} after ${limits.timeoutMs / 60000} minutes`), { code: 'DREAM_EXECUTOR_TIMEOUT' })), limits.timeoutMs);
    const heartbeat = setInterval(() => {
      if (!stopping && !heartbeatPending && performance.now() - lastHeartbeat >= 10000) {
        lastHeartbeat = performance.now(); heartbeatPending = true;
        void publish().catch(() => {}).finally(() => { heartbeatPending = false; });
      }
    }, 10000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else void publish().catch(() => {});
    worker.on('message', (message: WorkerMessage) => {
      if (stopping) return;
      try {
        if (message.type === 'stage') setStage(message.stage);
        else if (message.type === 'result') finish(null, { ...message.result, executorThreadId: message.threadId });
        else if (message.type === 'failure') finish(Object.assign(new Error(message.error), { code: diagnosticCode(message.code) }));
        else if (message.type === 'model') {
          if (mode === 'legacy' && diagnostic.stage === 'starting') setStage('legacy');
          if (currentCall && !currentCall.finishedAt || diagnostic.calls.length >= 8) throw new Error('Unexpected concurrent generation call');
          const call: GenerationCall = { sequence: diagnostic.calls.length + 1, stage: mode === 'legacy' ? 'legacy' : diagnostic.stage,
            state: 'preparing', startedAt: clock(), updatedAt: clock(), elapsedMs: 0,
            inputBytes: Buffer.byteLength(message.prompt), outputBytes: 0, reasoningBytes: 0, chunkCount: 0 };
          diagnostic.calls.push(call); currentCall = call;
          // Capture and await metadata persistence before dispatching any paid call.
          const work = Promise.resolve().then(async () => {
            try {
              await publish(); if (stopping) return;
              const text = await capturedModel(message.prompt, { signal: controller.signal, onProgress: async (value: ModelProgress) => {
                if (stopping) return;
                const progress = structuredClone(validateModelProgress(value));
                if (progress.inputBytes !== call.inputBytes) throw new TypeError('Model progress input mismatch');
                Object.assign(call, progress); await publish();
              } });
              if (stopping) return;
              call.state = 'completed'; call.outputBytes = Buffer.byteLength(text); call.finishedAt = clock();
              call.elapsedMs = Math.max(0, Date.parse(call.finishedAt) - Date.parse(call.startedAt)); call.updatedAt = call.finishedAt;
              await publish(); if (!stopping) worker.postMessage({ id: message.id, text });
            } catch (error) {
              if (stopping) return;
              call.state = 'failed'; call.failureCode ??= diagnosticCode(errorFields(error).code, 'MODEL_FAILED'); call.finishedAt = clock();
              call.elapsedMs = Math.max(0, Date.parse(call.finishedAt) - Date.parse(call.startedAt)); call.updatedAt = call.finishedAt;
              await publish(); if (!stopping) worker.postMessage({ id: message.id, error: errorFields(error).message ?? String(error), code: call.failureCode });
            }
          });
          calls.add(work); void work.then(() => calls.delete(work), error => { calls.delete(work); finish(error); });
        }
      } catch (error) { finish(error); }
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { exited(); if (!stopping) finish(new Error(`Dream executor exited before returning a result (${code})`)); });
  });
}
