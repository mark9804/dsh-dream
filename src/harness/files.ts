import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { HostContext, Agent } from './types.js';
import type { Files, ReadOptions, DreamConfig, Version } from '../types.js';
import { errorFields } from '../types.js';
const queues = new Map<string, Promise<void>>();
// Only operations that have finished may be recovered while their PID is alive.
// Retain tokens, never a writer/agent/policy closure from the failed release.
const pendingReleases = new Set<string>();
const contention = (error: unknown) => ['FS_NOT_OBSERVED', 'FS_STALE_VERSION', 'EEXIST'].includes(errorFields(error).code!);
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
function unavailable(message: string) { return Object.assign(new Error(message), { code: 'UNAVAILABLE' }); }

/** All production I/O stays on the Host filesystem seam with session policy. */
export function createHostFiles(ctx: HostContext, agent: Agent, { roots, signal }: { roots?: Pick<DreamConfig, 'memoryRoot' | 'stateRoot' | 'personaPath'>; signal?: AbortSignal } = {}): Files & { withGenerationLock<T>(operation: () => Promise<T>): Promise<T>; remove(): Promise<never> } {
  const fs = ctx.fs;
  for (const method of ['resolve', 'stat', 'contains', 'readText', 'listDir', 'writeText'] as const) {
    if (typeof fs?.[method] !== 'function') throw unavailable(`Harness filesystem ${method} unavailable`);
  }
  if (!roots?.memoryRoot || !roots?.stateRoot) throw new TypeError('Explicit memoryRoot and stateRoot are required');
  const directories = [roots.memoryRoot, roots.stateRoot].map(path => {
    if (!isAbsolute(path)) throw new TypeError('Filesystem roots must be absolute');
    return resolve(path);
  });
  const personaPath = roots.personaPath && resolve(roots.personaPath);
  if (roots.personaPath && !isAbsolute(roots.personaPath)) throw new TypeError('personaPath must be absolute');
  if (fs.sandboxMode !== undefined && typeof ctx.sandboxPolicy?.resolve !== 'function') throw unavailable('Session sandbox policy unavailable');

  async function target(path: string, operationSignal?: AbortSignal) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Host file paths must be absolute');
    const absolute = resolve(path);
    const allowedDirectory = directories.find(root => inside(root, absolute));
    if (!allowedDirectory && absolute !== personaPath) throw new Error('File path is outside the configured roots');
    const entry = await fs.resolve(absolute, { signal: operationSignal });
    const allowed = await fs.resolve(allowedDirectory ?? personaPath!, { signal: operationSignal });
    if (!fs.contains(allowed, entry)) throw new Error('File path resolves outside the configured roots');
    return entry;
  }
  async function read(path: string, options: ReadOptions | AbortSignal | undefined = signal) {
    // Preserve read(path, AbortSignal), including internal lock reads.
    const isSignal = options !== undefined && 'throwIfAborted' in options && typeof options.throwIfAborted === 'function';
    const operationSignal = isSignal ? options : (options as ReadOptions | undefined)?.signal ?? signal;
    const maxBytes = isSignal ? undefined : (options as ReadOptions | undefined)?.maxBytes;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new TypeError('maxBytes must be a non-negative safe integer');
    const entry = await target(path, operationSignal);
    const before = await fs.stat(entry, operationSignal);
    if (!before) return null;
    if (before.type !== 'file') throw new Error('Expected a regular file');
    let content;
    if (maxBytes === undefined) content = await fs.readText(entry, operationSignal);
    else {
      const tooLarge = () => Object.assign(new Error('File exceeds the read byte budget'), { code: 'FS_TOO_LARGE' });
      if (before.size! > maxBytes) throw tooLarge();
      if (typeof fs.readBytes !== 'function') throw unavailable('Harness bounded filesystem readBytes unavailable');
      const bytes = await fs.readBytes(entry, operationSignal, maxBytes);
      if (bytes.byteLength > maxBytes) throw tooLarge();
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw Object.assign(new Error('Expected UTF-8 text'), { code: 'FS_NOT_TEXT' }); }
      if (content.includes('\u0000')) throw Object.assign(new Error('Expected a text file'), { code: 'FS_NOT_TEXT' });
    }
    const after = await fs.stat(entry, operationSignal);
    if (!after || after.version !== before.version) throw Object.assign(new Error('File changed while reading'), { code: 'FS_STALE_VERSION' });
    return { content, version: after.version! };
  }
  async function put(path: string, content: string, expectedVersion: Version, operationSignal?: AbortSignal) {
    if (typeof content !== 'string') throw new TypeError('File content must be text');
    const entry = await target(path, operationSignal);
    const policy = ctx.sandboxPolicy?.resolve({ session: agent.session });
    const result = await fs.writeText(entry, content, expectedVersion === null
      ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: expectedVersion }, operationSignal, policy);
    return result.version;
  }
  async function list(path: string, operationSignal = signal) {
    const entry = await target(path, operationSignal);
    const info = await fs.stat(entry, operationSignal);
    if (!info) return [];
    if (info.type !== 'directory') throw new Error('Expected a directory');
    const result = [];
    for (const child of await fs.listDir(entry, operationSignal)) {
      await target(join(path, child.name), operationSignal);
      result.push({ name: child.name, isDirectory: child.type === 'directory' });
    }
    return result;
  }

  // shortcut: retain lock records because Host FS has no delete; replace with a Host lock service when available.
  async function acquire(kind: string, queueKey: string) {
    const directory = join(directories[0], kind === 'generation' ? '.dsh-dream-generation-locks' : '.dsh-dream-locks');
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const generations = (await list(directory)).map(entry => /^(\d+)\.acquire\.json$/.exec(entry.name)).filter(Boolean).map(match => Number(match![1]));
      const generation = generations.reduce((latest, value) => Math.max(latest, value), 0);
      if (generation) {
        const name = String(generation).padStart(12, '0');
        // Candidate lock record: existing identity/PID checks below remain authoritative.
        const owner = JSON.parse((await read(join(directory, `${name}.acquire.json`)))!.content) as { ownerToken: string; pid: number };
        if (typeof owner.ownerToken !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid persisted lock owner');
        const pendingKey = JSON.stringify([queueKey, name, owner.ownerToken]);
        const released = await read(join(directory, `${name}.released.json`));
        if (released) {
          if ((JSON.parse(released.content) as { ownerToken?: unknown }).ownerToken !== owner.ownerToken) throw new Error('Lock release does not match its owner');
          pendingReleases.delete(pendingKey);
        } else {
          const finishedHere = owner.pid === process.pid && pendingReleases.has(pendingKey);
          let dead = false;
          if (!finishedHere) {
            try { process.kill(owner.pid, 0); }
            catch (error) { if (errorFields(error).code! === 'ESRCH') dead = true; else throw error; }
          }
          if (!dead && !finishedHere) throw Object.assign(new Error('The memory root is locked by another operation'), { code: 'LOCKED' });
          // The new caller's current policy must authorize recovery. A denial
          // leaves the token pending and never runs the protected operation.
          try {
            await put(join(directory, `${name}.released.json`), JSON.stringify({ ownerToken: owner.ownerToken, abandoned: dead }), null, signal);
            pendingReleases.delete(pendingKey);
          } catch (error) { if (contention(error)) continue; throw error; }
        }
      }
      const name = String(generation + 1).padStart(12, '0');
      const ownerToken = randomUUID();
      try {
        await put(join(directory, `${name}.acquire.json`), JSON.stringify({ ownerToken, pid: process.pid }), null, signal);
        return async () => {
          const pendingKey = JSON.stringify([queueKey, name, ownerToken]);
          pendingReleases.add(pendingKey);
          await put(join(directory, `${name}.released.json`), JSON.stringify({ ownerToken }), null, undefined);
          pendingReleases.delete(pendingKey);
        };
      } catch (error) { if (!contention(error)) throw error; }
    }
    throw Object.assign(new Error('The memory root lock changed while acquiring it'), { code: 'LOCKED' });
  }

  async function withLock<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    const root = await target(directories[0], signal);
    const queueKey = `${kind}:${root.targetKey}`;
    const run = (queues.get(queueKey) ?? Promise.resolve()).then(async () => {
      const release = await acquire(kind, queueKey);
      let failure;
      try { return await operation(); }
      catch (error) { failure = error; throw error; }
      finally {
        try { await release(); }
        catch (error) {
          if (failure) throw new AggregateError([failure, error], 'Operation and lock release failed');
          throw error;
        }
      }
    });
    const tail = run.then(() => undefined, () => undefined);
    queues.set(queueKey, tail);
    try { return await run; }
    finally { if (queues.get(queueKey) === tail) queues.delete(queueKey); }
  }

  return {
    read,
    async stat(path) {
      const info = await fs.stat(await target(path, signal), signal);
      if (!info) return null;
      return { type: info.type, ...(info.size === undefined ? {} : { size: info.size }), ...(info.version === undefined ? {} : { version: info.version }) };
    },
    write: (path, content, version) => put(path, content, version, signal),
    list,
    async mkdir(path) {
      const entry = await target(path, signal);
      const existing = await fs.stat(entry, signal);
      if (existing && existing.type !== 'directory') throw new Error('Expected a directory');
      // Host writeText creates parent directories on the first actual write.
    },
    async remove() { throw unavailable('Harness filesystem does not expose removal'); },
    withLock: (_key, operation) => withLock('state', operation),
    withGenerationLock: operation => withLock('generation', operation),
  };
}
