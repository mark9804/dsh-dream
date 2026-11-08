import { Worker } from 'node:worker_threads';
import type { Model } from '../types.js';
import { errorFields } from '../types.js';
import type { FreeDreamInput, FreeDreamOutput } from './free-narrative.js';
export type DreamWriter = (input: FreeDreamInput, options?: { signal?: AbortSignal }) => Promise<FreeDreamOutput>;

/** Independent event loop, UUID model calls and cancellation lifetime for dreams.
 * No memory-generation lock, main-agent maintenance, tools, or factual authority. */
export function createFreeDreamWriter(model: Model, { timeoutMs, maxOutputBytes }: { timeoutMs: number; maxOutputBytes: number }): DreamWriter {
  return (input, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const capturedModel = model.capture?.() ?? model;
    const controller = new AbortController();
    const worker = new Worker(new URL('./free-worker.js', import.meta.url), { workerData: { input, maxOutputBytes } });
    const calls = new Set<Promise<void>>();
    let stopping = false;
    let exited!: () => void;
    const workerExited = new Promise<void>(done => { exited = done; });
    const finish = (error: unknown, result?: FreeDreamOutput) => {
      if (stopping) return; stopping = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.abort(error ?? new Error('Dream task finished'));
      const termination = Promise.resolve().then(() => worker.terminate());
      void Promise.allSettled([termination, workerExited, ...calls]).then(outcomes => {
        const failure = outcomes.find(o => o.status === 'rejected');
        if (error) reject(error); else if (failure) reject(failure.reason); else resolve(result!);
      });
    };
    const abort = () => finish(signal!.reason ?? new Error('Dream task cancelled'));
    const timer = setTimeout(() => finish(Object.assign(new Error('Independent dream task timed out'), { code: 'DREAM_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (message: { type: string; id: number; prompt: string; error: string; result: FreeDreamOutput }) => {
      if (stopping) return;
      if (message.type === 'result') finish(null, message.result);
      else if (message.type === 'failure') finish(new Error(message.error));
      else if (message.type === 'model') {
        const call = Promise.resolve().then(async () => {
          if (stopping) return;
          try { const text = await capturedModel(message.prompt, { signal: controller.signal }); if (!stopping) worker.postMessage({ id: message.id, text }); }
          catch (error) { if (!stopping) worker.postMessage({ id: message.id, error: errorFields(error).message ?? String(error) }); }
        });
        calls.add(call); void call.then(() => calls.delete(call), error => { calls.delete(call); finish(error); });
      }
    });
    worker.on('error', error => finish(error));
    worker.on('exit', code => { exited(); if (!stopping) finish(new Error(`Dream worker exited without a result (${code})`)); });
  });
}
