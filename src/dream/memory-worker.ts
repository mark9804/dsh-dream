import { parentPort, workerData, threadId } from 'node:worker_threads';
import { runMemoryStages } from './memory-pipeline.js';
import type { Snapshot, DreamConfig } from '../types.js';
import { errorFields } from '../types.js';
import { validateQuoteValidationIssue } from '../domain/quote-diagnostics.js';
const data = workerData as { snapshot: Snapshot; jobId: string; limits: DreamConfig };
const port = parentPort!;
const calls = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
let sequence = 0;
port.on('message', (message: { id: number; error?: string; code?: string; text: string }) => {
  const call = calls.get(message.id); if (!call) return; calls.delete(message.id);
  if (message.error) call.reject(Object.assign(new Error(message.error), { code: message.code, modelFailure: true })); else call.resolve(message.text);
});
const model = (prompt: string) => new Promise<string>((resolve, reject) => { const id = ++sequence; calls.set(id, { resolve, reject }); port.postMessage({ type: 'model', id, prompt }); });
try { const result = await runMemoryStages(data.snapshot, data.jobId, model, data.limits, stage => port.postMessage({ type: 'stage', stage })); port.postMessage({ type: 'result', result: { ...result, executorThreadId: threadId } }); }
catch (error) {
  const fields = errorFields(error);
  let validationIssue;
  try { const value = (error as { validationIssue?: unknown })?.validationIssue; if (value !== undefined) validationIssue = validateQuoteValidationIssue(value); } catch { /* Never send arbitrary exception properties. */ }
  // Model/provider exceptions retain their transport code; only local output
  // validation failures become private attempt records in the Host executor.
  const validation = (error as { modelFailure?: unknown })?.modelFailure !== true
    && (fields.code === 'GENERATION_VALIDATION_FAILED' || error instanceof TypeError && fields.code === undefined);
  port.postMessage({ type: 'failure', error: fields.message, code: validation ? 'GENERATION_VALIDATION_FAILED' : fields.code, localValidation: validation, ...(validation && validationIssue ? { validationIssue } : {}) });
}
finally { port.close(); }
