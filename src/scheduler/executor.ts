import { Worker } from 'node:worker_threads';
import type { Model, DreamConfig, Generate, DreamResult } from '../types.js';
import { errorFields } from '../types.js';
type WorkerMessage = { type: 'result'; result: DreamResult; threadId: number } | { type: 'failure'; error: string } | { type: 'model'; id: number; prompt: string };

/**
 * Run orchestration in its own event loop; model authority stays in Host.
 * Cancellation stops dispatch immediately, but settlement means actual drain:
 * the worker has exited and every started model call (including cleanup) settled.
 * A model ignoring abort deliberately keeps this promise and its caller's
 * single-flight lock pending. There is no safe in-process force-drain timeout.
 */
export function createWorkerGenerator(model: Model, limits: Pick<DreamConfig, 'timeoutMs' | 'maxOutputBytes' | 'maxProposals'>): Generate {
  return (snapshot, jobId, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const controller = new AbortController();
    const worker = new Worker(new URL('../dream/worker.js', import.meta.url), {
      workerData: { snapshot, jobId, limits: { maxOutputBytes: limits.maxOutputBytes, maxProposals: limits.maxProposals } },
    });
    const calls = new Set<Promise<void>>();
    let stopping = false;
    let exited!: () => void;
    const workerExited = new Promise<void>(done => { exited = done; });
    const finish = (error: unknown, result?: DreamResult) => {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort(error ?? new Error('Dream executor finished'));
      // Include actual exit as well: a failed termination request is not proof
      // that the worker stopped. No caller may release its lock on that basis.
      const termination = Promise.resolve().then(() => worker.terminate());
      void Promise.allSettled([termination, workerExited, ...calls]).then(outcomes => {
        const cleanupFailure = outcomes.find(outcome => outcome.status === 'rejected');
        if (error) reject(error);
        else if (cleanupFailure) reject(cleanupFailure.reason);
        else resolve(result!); // Only the result message calls finish without an error.
      });
    };
    const abort = () => finish(signal!.reason ?? new Error('Dream cancelled'));
    const timer = setTimeout(() => finish(new Error('Dream executor timed out')), limits.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: WorkerMessage) => {
      if (stopping) return;
      if (message.type === 'result') finish(null, { ...message.result, executorThreadId: message.threadId });
      else if (message.type === 'failure') finish(new Error(message.error));
      else if (message.type === 'model') {
        // Register before entering user/model code, which may abort synchronously.
        const call = Promise.resolve().then(async () => {
          if (stopping) return;
          try {
            const text = await model(message.prompt, { signal: controller.signal });
            if (!stopping) worker.postMessage({ id: message.id, text });
          } catch (error) {
            if (!stopping) worker.postMessage({ id: message.id, error: errorFields(error).message ?? String(error) });
          }
        });
        calls.add(call);
        void call.then(() => calls.delete(call), error => {
          calls.delete(call);
          finish(error);
        });
      }
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => {
      exited();
      if (!stopping) finish(new Error(`Dream executor exited before returning a result (${code})`));
    });
  });
}
