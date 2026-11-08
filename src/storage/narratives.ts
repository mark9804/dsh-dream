import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import type { Files, Scope, ErrorInfo } from '../types.js';
import type { FreeDreamInput, FreeDreamOutput } from '../dream/free-narrative.js';
import { validateFreeDreamInput, validateFreeDreamOutput } from '../dream/free-narrative.js';
export interface NarrativeTask {
  schemaVersion: 1; jobId: string; scope: Scope; state: 'queued' | 'generating' | 'completed' | 'failed' | 'disabled';
  input?: FreeDreamInput; inputDigest?: string; attemptId?: string; attempts: number;
  ownerPid?: number; sensitive?: boolean; createdAt: string; updatedAt: string; date: string; output?: FreeDreamOutput; dreamPath?: string; error?: ErrorInfo;
}
const MAX_TASK_BYTES = 262144;
const activeKey = Symbol.for('dsh-dream.active-narrative-attempts.v1');
const shared = globalThis as unknown as Record<symbol, Set<string> | undefined>;
const activeAttempts = shared[activeKey] ??= new Set<string>();
export const narrativeAttemptActive = (id: string | undefined) => id !== undefined && activeAttempts.has(id);
export const releaseNarrativeAttempt = (id: string) => { activeAttempts.delete(id); };
const boundedError = (error: ErrorInfo): ErrorInfo => ({ code: String(error.code).slice(0, 128), message: String(error.message).slice(0, 2048) });
const hash = (input: FreeDreamInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function validate(value: unknown): NarrativeTask {
  const task = value as NarrativeTask;
  if (!task || typeof task !== 'object' || task.schemaVersion !== 1 || typeof task.jobId !== 'string' || !task.jobId.trim() || !task.scope || Object.values(task.scope).some(v => typeof v !== 'string' || !v.trim()) || !['queued', 'generating', 'completed', 'failed', 'disabled'].includes(task.state) || !Number.isSafeInteger(task.attempts) || task.attempts < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(task.date) || !Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))) throw new TypeError('Invalid independent dream task');
  if (task.input) { validateFreeDreamInput(task.input); if (task.input.jobId !== task.jobId || task.inputDigest !== hash(task.input)) throw new TypeError('Dream task input identity or digest mismatch'); }
  if (task.state === 'queued' && !task.input) throw new TypeError('Queued dream requires frozen input');
  if (task.state === 'generating' && (!task.input || !task.attemptId || !Number.isSafeInteger(task.ownerPid) || task.ownerPid! <= 0)) throw new TypeError('Generating dream requires frozen input and an owner');
  if (task.output) validateFreeDreamOutput(task.output);
  if (task.state === 'completed' && (!task.output || !task.dreamPath)) throw new TypeError('Completed dream requires persisted output');
  return task;
}

/** Separate record namespace and lock: never owns the factual generation lock.
 * CAS and unique attempt IDs prevent late completion from winning after retry. */
export function createNarrativeStore(files: Files, { root, scope, now = () => new Date().toISOString() }: { root: string; scope: Scope; now?: () => string }) {
  const directory = posix.join(root, 'dream-tasks');
  const path = (jobId: string) => {
    if (typeof jobId !== 'string' || !jobId.trim()) throw new TypeError('Dream task needs job id');
    return posix.join(directory, `${encodeURIComponent(jobId)}.json`);
  };
  const locked = <T>(work: () => Promise<T>) => files.withLock(`dream-tasks:${scope.scopeId}`, work);
  async function read(jobId: string) {
    const file = await files.read(path(jobId), { maxBytes: 262144 }); if (!file) return null;
    const task = validate(JSON.parse(file.content));
    if (task.jobId !== jobId || !isDeepStrictEqual(task.scope, scope)) throw new TypeError('Independent dream task scope mismatch');
    return { task, version: file.version };
  }
  async function save(task: NarrativeTask, version: import('../types.js').Version) {
    validate(task);
    const content = `${JSON.stringify(task, null, 2)}\n`;
    // Reserve headroom for future attempt/error/path control metadata so a
    // writable result cannot make subsequent fail/complete unreadable.
    const payload = { ...task, error: undefined, dreamPath: undefined, attemptId: undefined, ownerPid: undefined };
    if (Buffer.byteLength(content) > MAX_TASK_BYTES || Buffer.byteLength(JSON.stringify(payload, null, 2)) > MAX_TASK_BYTES - 16384) throw new RangeError('Independent dream record exceeds its read/write byte budget');
    await files.mkdir(directory); await files.write(path(task.jobId), content, version); return task;
  }
  async function create(jobId: string, input: FreeDreamInput | undefined, date: string, state: 'queued' | 'disabled' | 'failed', error?: ErrorInfo, sensitive = false) {
    return locked(async () => {
      const previous = await read(jobId);
      if (previous) {
        if (input && previous.task.input && hash(input) !== previous.task.inputDigest) throw new Error('Independent dream input cannot change');
        return previous.task;
      }
      const task: NarrativeTask = { schemaVersion: 1, jobId, scope: structuredClone(scope), state, sensitive, attempts: 0, date, createdAt: now(), updatedAt: now(), ...(input ? { input: structuredClone(input), inputDigest: hash(input) } : {}), ...(error ? { error: boundedError(error) } : {}) };
      return save(task, null);
    });
  }
  async function update(jobId: string, fn: (task: NarrativeTask) => NarrativeTask) {
    return locked(async () => { const old = await read(jobId); if (!old) throw new Error('Unknown independent dream task'); return save(fn(old.task), old.version); });
  }
  return {
    create,
    async get(jobId: string) { return (await read(jobId))?.task ?? null; },
    async list() { const tasks: NarrativeTask[] = []; for (const entry of await files.list(directory)) if (!entry.isDirectory && entry.name.endsWith('.json')) { const task = await read(decodeURIComponent(entry.name.slice(0, -5))); if (task) tasks.push(task.task); } return tasks; },
    async claim(jobId: string) {
      let attemptId: string | undefined;
      try {
        return await locked(async () => { const old = await read(jobId); if (!old || old.task.state !== 'queued') return null;
          attemptId = randomUUID(); activeAttempts.add(attemptId);
          return save({ ...old.task, state: 'generating', attemptId, ownerPid: process.pid, attempts: old.task.attempts + 1, updatedAt: now(), error: undefined }, old.version);
        });
      } catch (error) { if (attemptId) activeAttempts.delete(attemptId); throw error; }
    },
    async reclaimPublication(jobId: string) {
      let attemptId: string | undefined;
      try {
        return await locked(async () => {
          const old = await read(jobId);
          if (!old || old.task.state !== 'generating' || !old.task.output) return null;
          if (old.task.ownerPid === process.pid ? narrativeAttemptActive(old.task.attemptId) : (() => { try { process.kill(old.task.ownerPid!, 0); return true; } catch (e) { return (e as { code?: string }).code !== 'ESRCH'; } })()) return null;
          attemptId = randomUUID(); activeAttempts.add(attemptId);
          return save({ ...old.task, attemptId, ownerPid: process.pid, updatedAt: now() }, old.version);
        });
      } catch (error) { if (attemptId) activeAttempts.delete(attemptId); throw error; }
    },
    async result(jobId: string, attemptId: string, output: FreeDreamOutput) {
      validateFreeDreamOutput(output);
      return update(jobId, task => { if (task.state !== 'generating' || task.attemptId !== attemptId) throw new Error('Obsolete independent dream completion'); return { ...task, output: structuredClone(output), updatedAt: now() }; });
    },
    async complete(jobId: string, attemptId: string, dreamPath: string) {
      if (typeof dreamPath !== 'string' || !dreamPath.trim() || Buffer.byteLength(dreamPath) > 4096) throw new TypeError('Independent dream path exceeds control metadata budget');
      return update(jobId, task => { if (task.state !== 'generating' || task.attemptId !== attemptId || !task.output) throw new Error('Independent dream output not persisted'); return { ...task, state: 'completed', dreamPath, updatedAt: now() }; });
    },
    async fail(jobId: string, error: ErrorInfo, attemptId?: string) {
      return update(jobId, task => {
        if (task.state === 'completed' || task.state === 'disabled' || (attemptId && task.attemptId !== attemptId)) return task;
        return { ...task, state: 'failed', updatedAt: now(), error: boundedError(error) };
      });
    },
    async prepareRetry(jobId: string, input: FreeDreamInput, sensitive = false) {
      return update(jobId, task => {
        if (task.state !== 'failed' || task.input || task.output) throw new Error('Dream task is not a failed input preparation');
        const frozen = validateFreeDreamInput(input);
        if (frozen.jobId !== task.jobId) throw new Error('Dream retry input identity mismatch');
        return { ...task, sensitive: task.sensitive || sensitive, input: frozen, inputDigest: hash(frozen), state: 'queued', attemptId: undefined, ownerPid: undefined, updatedAt: now(), error: undefined };
      });
    },
    async retry(jobId: string) {
      return update(jobId, task => {
        if (task.state !== 'failed' || !task.input) throw new Error('Dream task has no retryable frozen input');
        return { ...task, state: 'queued', attemptId: undefined, ownerPid: undefined, updatedAt: now(), error: undefined };
      });
    },
    async disable(jobId: string) {
      return update(jobId, task => task.state === 'completed' ? task : { ...task, state: 'disabled', updatedAt: now() });
    },
  };
}
