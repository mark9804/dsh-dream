import { parentPort, workerData, threadId } from 'node:worker_threads';
import { runDreamStages } from './pipeline.js';

import type { Snapshot, DreamConfig } from '../types.js';
import { errorFields } from '../types.js';
// Only the executor creates this worker and its message channel.
const data = workerData as { snapshot: Snapshot; jobId: string; limits: DreamConfig };
const port = parentPort!;
const calls = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
let sequence = 0;
port.on('message', (message: { id: number; error?: string; code?: string; text: string }) => {
  const call = calls.get(message.id);
  if (!call) return;
  calls.delete(message.id);
  if (message.error) call.reject(Object.assign(new Error(message.error), { code: message.code }));
  else call.resolve(message.text);
});

const model = (prompt: string) => new Promise<string>((resolve, reject) => {
  const id = ++sequence;
  calls.set(id, { resolve, reject });
  port.postMessage({ type: 'model', id, prompt });
});

try {
  const result = await runDreamStages(data.snapshot, data.jobId, model, data.limits);
  port.postMessage({ type: 'result', result, threadId });
} catch (error) {
  port.postMessage({ type: 'failure', error: errorFields(error).message, code: errorFields(error).code });
} finally {
  port.close();
}
