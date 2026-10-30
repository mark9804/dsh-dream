import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';

import type { Files, ReadOptions, Version } from '../types.js';
import { errorFields } from '../types.js';
const writes = new Map<string, Promise<string>>();

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

/** A confined filesystem for synthetic fixtures and explicit local demonstrations. */
export function createLocalFiles(root: string): Files & { remove(path: string): Promise<void> } {
  const base = resolve(root);

  async function pathOf(path: string) {
    if (typeof path !== 'string' || !path || isAbsolute(path)) {
      throw failure('PATH_NOT_ALLOWED', 'Expected a non-empty relative path');
    }
    const target = resolve(base, path);
    const part = relative(base, target);
    if (part === '..' || part.startsWith(`..${sep}`)) {
      throw failure('PATH_NOT_ALLOWED', 'Path leaves the filesystem root');
    }
    let cursor = base;
    for (const component of ['', ...part.split(sep).filter(Boolean)]) {
      if (component) cursor = join(cursor, component);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) {
          throw failure('PATH_NOT_ALLOWED', 'Symlinks are not supported in the local fixture filesystem');
        }
      } catch (error) {
        if (errorFields(error).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }

  async function read(path: string, { maxBytes }: ReadOptions = {}) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new TypeError('maxBytes must be a non-negative safe integer');
    }
    try {
      const target = await pathOf(path);
      if (maxBytes === undefined) {
        const content = await readFile(target, 'utf8');
        return { content, version: content };
      }
      const handle = await open(target, 'r');
      try {
        if ((await handle.stat()).size > maxBytes) throw failure('FS_TOO_LARGE', 'File exceeds the read budget');
        const chunks = [];
        let size = 0;
        while (size <= maxBytes) {
          const buffer = Buffer.alloc(Math.min(65536, maxBytes - size + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > maxBytes) throw failure('FS_TOO_LARGE', 'File exceeds the read budget');
          chunks.push(buffer.subarray(0, bytesRead));
        }
        const content = Buffer.concat(chunks, size).toString('utf8');
        return { content, version: content };
      } finally { await handle.close(); }
    } catch (error) {
      if (errorFields(error).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function write(path: string, content: string, expectedVersion: Version) {
    if (typeof content !== 'string' || !(expectedVersion === null || typeof expectedVersion === 'string')) {
      throw new TypeError('Local writes require text and a content version or null');
    }
    const target = await pathOf(path);
    const previous = writes.get(target) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await mkdir(dirname(target), { recursive: true });
      await pathOf(path);
      const current = await read(path);
      if ((current?.version ?? null) !== expectedVersion) {
        throw failure('FILE_CONFLICT', 'File changed since it was read');
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (expectedVersion === null) {
          try { await link(temporary, target); }
          catch (error) {
            if (errorFields(error).code === 'EEXIST') throw failure('FILE_CONFLICT', 'File was created by another writer');
            throw error;
          }
        } else {
          // shortcut: local compare/rename is cooperative, use Host version guards for production writes.
          if ((await read(path))?.version !== expectedVersion) {
            throw failure('FILE_CONFLICT', 'File changed before replacement');
          }
          await rename(temporary, target);
        }
        return content;
      } finally {
        await unlink(temporary).catch((error) => { if (errorFields(error).code !== 'ENOENT') throw error; });
      }
    });
    writes.set(target, task);
    try { return await task; }
    finally { if (writes.get(target) === task) writes.delete(target); }
  }

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (typeof key !== 'string' || !key || typeof fn !== 'function') throw new TypeError('Invalid lock');
    const path = `.dream-locks/${encodeURIComponent(key)}.json`;
    const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
    // Immutable generations avoid check/unlink races: neither a reclaimer nor a
    // releasing owner can remove a newer owner's lock. Keep generation zero at
    // the old pathname so an existing live/incomplete legacy lock still blocks.
    for (let generation = 0; generation < 10000; generation++) {
      const acquired = generation === 0 ? path : `${path}.${generation}`;
      const released = `${acquired}.released`;
      const existing = await read(acquired);
      if (existing) {
        if ((await read(released))?.content === existing.content) continue;
        let record: { pid?: number } | undefined;
        try { record = JSON.parse(existing.content); } catch { /* Fail closed on incomplete owners. */ }
        let dead = false;
        if (Number.isSafeInteger(record?.pid) && record!.pid! > 0) {
          try { process.kill(record!.pid!, 0); }
          catch (probe) { if (errorFields(probe).code === 'ESRCH') dead = true; }
        }
        if (dead) continue;
        throw failure('RESOURCE_BUSY', 'Memory root is locked by another owner');
      }
      try { await write(acquired, owner, null); }
      catch (error) {
        if (errorFields(error).code === 'FILE_CONFLICT') throw failure('RESOURCE_BUSY', 'Memory root is locked by another owner');
        throw error;
      }
      try { return await fn(); }
      finally { await write(released, owner, null); }
    }
    throw failure('RESOURCE_BUSY', 'Memory-root lock generation limit reached');
  }

  return {
    read,
    write,
    withLock,
    async mkdir(path) { await mkdir(await pathOf(path), { recursive: true }); },
    async stat(path) {
      try {
        const entry = await lstat(await pathOf(path));
        return { type: entry.isDirectory() ? 'directory' : 'file', size: entry.size };
      } catch (error) {
        if (errorFields(error).code === 'ENOENT') return null;
        throw error;
      }
    },
    async list(path) {
      try {
        return (await readdir(await pathOf(path), { withFileTypes: true }))
          .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } catch (error) {
        if (errorFields(error).code === 'ENOENT') return [];
        throw error;
      }
    },
    async remove(path) {
      try { await unlink(await pathOf(path)); }
      catch (error) { if (errorFields(error).code !== 'ENOENT') throw error; }
    },
  };
}
