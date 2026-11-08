import { parentPort, workerData } from 'node:worker_threads';
import { runFreeDream } from './free-narrative.js';
import type { FreeDreamInput } from './free-narrative.js';
import { errorFields } from '../types.js';
const { input, maxOutputBytes } = workerData as { input: FreeDreamInput; maxOutputBytes: number };
const port = parentPort!;
const calls = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
let sequence = 0;
port.on('message', (message: { id: number; error?: string; text: string }) => {
  const call = calls.get(message.id); if (!call) return; calls.delete(message.id);
  if (message.error) call.reject(new Error(message.error)); else call.resolve(message.text);
});
const model = (prompt: string) => new Promise<string>((resolve, reject) => { const id = ++sequence; calls.set(id, { resolve, reject }); port.postMessage({ type: 'model', id, prompt }); });
try { port.postMessage({ type: 'result', result: await runFreeDream(input, model, { maxOutputBytes }) }); }
catch (error) { port.postMessage({ type: 'failure', error: errorFields(error).message }); }
finally { port.close(); }
