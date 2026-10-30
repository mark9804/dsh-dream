import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { validateChangeSet, validateJob } from '../domain/contracts.js';

import type { Files, Version, Job, DreamResult, Review, Proposal, Manifest, ChangeSet, AfterStep, ReloadSource, ManifestEntry } from '../types.js';

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function key(value: string | undefined) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Expected a non-empty record id');
  return encodeURIComponent(value);
}

function parseRecord(content: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new TypeError('Stored record is not valid JSON'); }
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1) {
    throw new TypeError('Unsupported stored record version');
  }
  return value as Record<string, unknown>; // Object and schemaVersion checked above.
}

/** Persist plugin records and recover accepted multi-file changes through an injected filesystem. */
export function createStore(files: Files, { root = 'state', lockKey, now = () => new Date().toISOString() }: { root?: string; lockKey?: string; now?: () => string } = {}) {
  if (!files || (['read', 'write', 'mkdir', 'list', 'withLock'] as const).some((name) => typeof files[name] !== 'function')) {
    throw new TypeError('The storage adapter must provide files and a memory-root lock');
  }
  key(lockKey);
  if (typeof root !== 'string' || !root || root.split('/').includes('..')) throw new TypeError('Invalid state root');
  const path = (...parts: string[]) => posix.join(root, ...parts);
  const jobPath = (id: string) => path('jobs', `${key(id)}.json`);
  const dreamResultPath = (id: string) => path('dreams', 'results', `${key(id)}.json`);
  const transactionPath = (id: string) => path('transactions', key(id), 'manifest.json');
  const locked = <T>(fn: () => Promise<T>) => files.withLock(lockKey!, fn);

  async function load(pathname: string) {
    const stored = await files.read(pathname);
    return stored ? { value: parseRecord(stored.content), version: stored.version } : null;
  }

  async function save(pathname: string, value: unknown, version: Version) {
    await files.mkdir(posix.dirname(pathname));
    return files.write(pathname, `${JSON.stringify(value, null, 2)}\n`, version);
  }

  async function loadJob(jobId: string) {
    const stored = await load(jobPath(jobId));
    if (!stored) return null;
    const job = validateJob(stored.value);
    if (job.jobId !== jobId) throw new TypeError('Stored job id does not match its path');
    return job;
  }

  async function saveJob(job: Job) {
    validateJob(job);
    return locked(async () => {
      const pathname = jobPath(job.jobId);
      const stored = await load(pathname);
      await save(pathname, job, stored?.version ?? null);
      return job;
    });
  }

  async function updateJob(jobId: string, updater: (job: Job) => Job | Promise<Job>) {
    return locked(async () => {
      const pathname = jobPath(jobId);
      const stored = await load(pathname);
      if (!stored) throw failure('JOB_NOT_FOUND', 'Cannot update a missing job');
      validateJob(stored.value);
      const next = await updater(structuredClone(validateJob(stored.value)));
      validateJob(next);
      if (next.jobId !== jobId) throw new TypeError('Cannot change the job id');
      await save(pathname, next, stored.version);
      return next;
    });
  }

  function validateDreamResult(record: { schemaVersion?: unknown; jobId?: unknown; result?: unknown }, jobId: string): DreamResult {
    if (record.schemaVersion !== 1 || record.jobId !== jobId) throw new TypeError('Stored dream result identity or version is invalid');
    const result = record.result as DreamResult | undefined; // Candidate validated below; proposals are checked against the job before use.
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.dream !== 'string' || !result.dream.trim() || !Array.isArray(result.proposals)) {
      throw new TypeError('Invalid stored dream result');
    }
    return result;
  }

  async function loadDreamResult(jobId: string) {
    const stored = await load(dreamResultPath(jobId));
    return stored ? validateDreamResult(stored.value, jobId) : null;
  }

  /** Save once so retries cannot pair an earlier dream with different proposals. */
  async function saveDreamResult(jobId: string, result: DreamResult) {
    const pathname = dreamResultPath(jobId);
    const record = { schemaVersion: 1, jobId, result: structuredClone(result) };
    validateDreamResult(record, jobId);
    return locked(async () => {
      const existing = await load(pathname);
      if (existing) {
        const previous = validateDreamResult(existing.value, jobId);
        if (!isDeepStrictEqual(previous, record.result)) throw failure('RECORD_CONFLICT', 'Job already has another dream result');
        return previous;
      }
      await save(pathname, record, null);
      return record.result;
    });
  }

  async function appendDream({ jobId, date, text }: { jobId: string; date: string; text: string }) {
    key(jobId);
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof text !== 'string' || !text.trim()) {
      throw new TypeError('A dream needs a local date and text');
    }
    return locked(async () => {
      const marker = `<!-- dream-job:${encodeURIComponent(jobId)} -->`;
      const pathname = path('dreams', `${date.slice(2)}.md`);
      const current = await files.read(pathname);
      if (current?.content.includes(marker)) return pathname;
      await files.mkdir(posix.dirname(pathname));
      const content = `${current?.content ?? `# ${date}\n`}\n${marker}\n## ${jobId}\n\n> Dream content; not factual evidence.\n\n${text.trim()}\n`;
      await files.write(pathname, content, current?.version ?? null);
      return pathname;
    });
  }

  async function appendRejected({ review, proposal }: { review: Review; proposal: Proposal }) {
    if (review?.decision !== 'reject' || review.proposalId !== proposal?.proposalId || review.jobId !== proposal.jobId) {
      throw new TypeError('Rejected record must reference its proposal');
    }
    return locked(async () => {
      const pathname = path('rejected', `${key(review.reviewId)}.json`);
      const value = { schemaVersion: 1, review, proposal };
      const previous = await load(pathname);
      if (previous) {
        if (!isDeepStrictEqual(previous.value, value)) throw failure('RECORD_CONFLICT', 'Review id already has another rejection');
        return previous.value;
      }
      await save(pathname, value, null);
      return value;
    });
  }

  function validateManifest(input: unknown, transactionId: string): asserts input is Manifest {
    const manifest = input as Manifest; // Candidate validated below, including its change set.
    if (manifest.schemaVersion !== 1 || manifest.transactionId !== transactionId || !Array.isArray(manifest.entries) ||
      !Array.isArray(manifest.sources) ||
      !['prepared', 'applying', 'applied', 'cancelled'].includes(manifest.status)) throw new TypeError('Invalid transaction manifest');
    if (manifest.writeStarted !== undefined && typeof manifest.writeStarted !== 'boolean') throw new TypeError('Invalid transaction write marker');
    validateChangeSet(manifest.changeSet);
    if (manifest.changeSet.transactionId !== transactionId || manifest.jobId !== manifest.changeSet.jobId || manifest.entries.length !== manifest.changeSet.changes.length) {
      throw new TypeError('Transaction entries do not match the change set');
    }
    for (const [index, entry] of manifest.entries.entries()) {
      const change = manifest.changeSet.changes[index];
      if (entry.targetId !== change.targetId || typeof entry.path !== 'string' || !entry.path ||
        entry.before !== change.before || entry.after !== change.after || typeof entry.done !== 'boolean' ||
        entry.existed !== (change.version !== null)) {
        throw new TypeError('Invalid transaction entry');
      }
    }
    for (const source of manifest.sources) {
      if (typeof source.path !== 'string' || !source.path || typeof source.content !== 'string' ||
        !Object.hasOwn(source, 'version')) throw new TypeError('Invalid transaction source');
    }
  }

  async function finishJob(manifest: Manifest) {
    const pathname = jobPath(manifest.jobId);
    const stored = await load(pathname);
    if (!stored) throw failure('JOB_NOT_FOUND', 'Committed transaction has no job record');
    const job = validateJob(stored.value);
    if (job.appliedTransactionIds?.includes(manifest.transactionId)) return;
    const applied = new Set(manifest.changeSet.proposalIds);
    job.appliedProposalIds = [...new Set([...job.appliedProposalIds, ...applied])];
    job.committingProposalIds = (job.committingProposalIds ?? []).filter((id) => !applied.has(id));
    job.appliedTransactionIds = [...(job.appliedTransactionIds ?? []), manifest.transactionId];
    job.state = 'applied';
    job.updatedAt = manifest.appliedAt!;
    delete job.phase;
    delete job.checkpoint;
    delete job.error;
    validateJob(job);
    await save(pathname, job, stored.version);
  }

  /** Re-authorize the original input, not after-images observed during recovery. */
  async function requireCleanManifest(manifest: Manifest) {
    try {
      const job = await loadJob(manifest.jobId);
      if (!job) throw new TypeError('Transaction has no stored review job');
      const reviews = manifest.changeSet.reviewIds.map(id => job.reviews.find(review => review.reviewId === id));
      if (reviews.some(review => !review?.authority)) throw new TypeError('Transaction has no clean model acceptance');
      const original = reviews[0]!.basis;
      // The job may have refreshed a sibling after a partial write. Authorization
      // still binds the frozen original sources, while the complete source set and
      // scope must remain identifiable in that job.
      if (!isDeepStrictEqual(original.scope, job.scope) ||
        original.sources.length !== job.snapshot.sources.length ||
        original.sources.some(source => {
          const current = job.snapshot.sources.find(item => item.sourceId === source.sourceId);
          if (isDeepStrictEqual(current, source)) return false;
          const entry = manifest.entries.find(item => item.targetId === source.sourceId);
          return !current || !entry || current.content !== entry.after ||
            !isDeepStrictEqual({ ...current, content: source.content, version: source.version }, source);
        }) ||
        reviews.some(review => !isDeepStrictEqual(review!.basis, original))) {
        throw new TypeError('Transaction clean reviews do not share the full original input');
      }
      if (!isDeepStrictEqual(job.committingProposalIds, manifest.changeSet.proposalIds) ||
        !(job.state === 'prepared' || job.state === 'applying' ||
          (['failed', 'cancelled'].includes(job.state) && ['prepared', 'applying'].includes(job.checkpoint?.state ?? '')))) {
        throw new TypeError('Transaction differs from the stored committing job');
      }
      // Force unapplied validation even if a stored changeSet falsely claims to
      // be applied. Only the manifest's already-applied branch skips writes.
      validateChangeSet({ ...manifest.changeSet, status: 'prepared' }, {
        ...job, state: 'applying',
        snapshot: { ...job.snapshot, scope: original.scope, sources: original.sources },
      });
      if (manifest.sources.length !== original.sources.length ||
        new Set(manifest.sources.map(source => source.sourceId)).size !== manifest.sources.length ||
        new Set(manifest.sources.map(source => source.path)).size !== manifest.sources.length) {
        throw new TypeError('Transaction is missing its full clean source basis');
      }
      for (const source of original.sources) {
        const stored = manifest.sources.find(item => item.sourceId === source.sourceId);
        if (!stored || stored.content !== source.content || !isDeepStrictEqual(stored.version, source.version)) {
          throw new TypeError('Transaction source differs from clean model input');
        }
        const entry = manifest.entries.find(item => item.targetId === source.sourceId);
        if (entry && entry.path !== stored.path) throw new TypeError('Transaction target differs from the reviewed source path');
        if (manifest.entries.some(item => item.path === stored.path && item.targetId !== source.sourceId)) {
          throw new TypeError('Transaction writes through another reviewed source path');
        }
      }
      if (new Set(manifest.entries.map(entry => entry.path)).size !== manifest.entries.length) {
        throw new TypeError('Transaction targets must have distinct paths');
      }
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw failure('CLEAN_REVIEW_REQUIRED', `Transaction requires matching clean model acceptance: ${error.message}`);
    }
  }

  async function applyManifest(manifest: Manifest, version: Version, afterStep?: AfterStep) {
    const pathname = transactionPath(manifest.transactionId);
    if (manifest.status === 'cancelled') throw failure('TRANSACTION_CANCELLED', 'Transaction was cancelled before writing');
    if (manifest.status === 'applied') {
      await finishJob(manifest);
      return manifest;
    }
    await requireCleanManifest(manifest);
    for (const source of manifest.sources) {
      if (manifest.entries.some((entry) => entry.path === source.path)) continue;
      const current = await files.read(source.path);
      if ((current?.content ?? '') !== source.content || !isDeepStrictEqual(current?.version ?? null, source.version)) {
        throw failure('FILE_CONFLICT', 'Evidence changed before transaction completion');
      }
    }
    if (manifest.status === 'prepared') {
      manifest.status = 'applying';
      version = await save(pathname, manifest, version);
    }
    const currentFiles = await Promise.all(manifest.entries.map((entry) => files.read(entry.path)));
    for (const [index, entry] of manifest.entries.entries()) {
      const content = currentFiles[index]?.content ?? null;
      if (entry.done ? content !== entry.after : content !== entry.after && content !== (entry.existed ? entry.before : null)) {
        throw failure('FILE_CONFLICT', 'Target differs from the recoverable transaction versions');
      }
      // The after image is an idempotent crash checkpoint, not permission to
      // rebase a still-unwritten before image onto a newly observed version.
      if (!entry.done && content !== entry.after &&
        !isDeepStrictEqual(currentFiles[index]?.version ?? null, manifest.changeSet.changes[index].version)) {
        throw failure('FILE_CONFLICT', 'Target version changed after review');
      }
    }
    for (const [index, entry] of manifest.entries.entries()) {
      const content = currentFiles[index]?.content ?? null;
      if (entry.done) continue;
      if (content !== entry.after) {
        if (!manifest.writeStarted) {
          manifest.writeStarted = true;
          version = await save(pathname, manifest, version);
        }
        await files.mkdir(posix.dirname(entry.path));
        await files.write(entry.path, entry.after, manifest.changeSet.changes[index].version);
        await afterStep?.({ phase: 'written', index, manifest: structuredClone(manifest) });
      }
      entry.done = true;
      version = await save(pathname, manifest, version);
      await afterStep?.({ phase: 'recorded', index, manifest: structuredClone(manifest) });
    }
    manifest.status = 'applied';
    manifest.appliedAt = now();
    await save(pathname, manifest, version);
    await afterStep?.({ phase: 'applied', manifest: structuredClone(manifest) });
    await finishJob(manifest);
    return manifest;
  }

  async function commit(changeSet: ChangeSet, resolveTarget: (id: string) => string | Promise<string>, { afterStep }: { afterStep?: AfterStep } = {}) {
    validateChangeSet(changeSet);
    if (typeof resolveTarget !== 'function') throw new TypeError('A target resolver is required');
    return locked(async () => {
      const pathname = transactionPath(changeSet.transactionId);
      const previous = await load(pathname);
      if (previous) {
        validateManifest(previous.value, changeSet.transactionId);
        if (!isDeepStrictEqual(previous.value.changeSet, changeSet)) {
          throw failure('TRANSACTION_CONFLICT', 'Transaction id already belongs to another change set');
        }
        return applyManifest(previous.value, previous.version, afterStep);
      }
      if (changeSet.status !== 'prepared') throw new TypeError('A new transaction must be prepared');
      const job = await loadJob(changeSet.jobId);
      if (!job) throw failure('JOB_NOT_FOUND', 'An accepted job is required for a new transaction');
      validateChangeSet(changeSet, job);
      const checked = new Set<string>();
      const sources: ReloadSource[] = [];
      for (const reviewId of changeSet.reviewIds) {
        const review = job.reviews.find((item) => item.reviewId === reviewId);
        for (const source of review!.basis.sources) {
          if (checked.has(source.sourceId)) continue;
          checked.add(source.sourceId);
          const sourcePath = await resolveTarget(source.sourceId);
          if (typeof sourcePath !== 'string' || !sourcePath) throw new TypeError('Reviewed source has no allowed path');
          const current = await files.read(sourcePath);
          if ((current?.content ?? '') !== source.content || !isDeepStrictEqual(current?.version ?? null, source.version)) {
            throw failure('FILE_CONFLICT', 'Reviewed evidence or target changed');
          }
          sources.push({ sourceId: source.sourceId, path: sourcePath, content: source.content, version: source.version });
        }
      }
      const entries: ManifestEntry[] = [];
      const targets = new Set<string>();
      for (const [index, change] of changeSet.changes.entries()) {
        const target = await resolveTarget(change.targetId);
        if (typeof target !== 'string' || !target || targets.has(target)) throw new TypeError('Targets must resolve to distinct allowed files');
        targets.add(target);
        const current = await files.read(target);
        if ((current?.content ?? '') !== change.before || !isDeepStrictEqual(current?.version ?? null, change.version)) {
          throw failure('FILE_CONFLICT', 'Target changed after review');
        }
        entries.push({ targetId: change.targetId, path: target, before: change.before, after: change.after,
          existed: change.version !== null,
          backup: change.version === null ? null : path('transactions', key(changeSet.transactionId), `before-${index}.md`), done: false });
      }
      for (const entry of entries) {
        if (!entry.backup) continue;
        const previousBackup = await files.read(entry.backup);
        if (previousBackup && previousBackup.content !== entry.before) throw failure('TRANSACTION_CONFLICT', 'Existing backup differs');
        if (!previousBackup) {
          await files.mkdir(posix.dirname(entry.backup));
          await files.write(entry.backup, entry.before, null);
        }
      }
      const manifest: Manifest = { schemaVersion: 1, transactionId: changeSet.transactionId, jobId: changeSet.jobId,
        status: 'prepared', writeStarted: false, changeSet: structuredClone(changeSet), entries, sources };
      const version = await save(pathname, manifest, null);
      await afterStep?.({ phase: 'prepared', manifest: structuredClone(manifest) });
      return applyManifest(manifest, version, afterStep);
    });
  }

  async function recover(transactionId: string, { afterStep }: { afterStep?: AfterStep } = {}) {
    return locked(async () => {
      const stored = await load(transactionPath(transactionId));
      if (!stored) throw failure('TRANSACTION_NOT_FOUND', 'No recovery manifest exists');
      validateManifest(stored.value, transactionId);
      return applyManifest(stored.value, stored.version, afterStep);
    });
  }

  /** End only transactions provably never passed the persisted write boundary. */
  async function cancelUnwritten(transactionId: string, { reason = 'Reviewed inputs changed' } = {}) {
    if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('Cancellation requires a reason');
    return locked(async () => {
      const pathname = transactionPath(transactionId);
      const stored = await load(pathname);
      if (!stored) return null;
      const manifest = stored.value;
      validateManifest(manifest, transactionId);
      if (manifest.status === 'cancelled') return manifest;
      const neverStarted = manifest.writeStarted === false ||
        (manifest.writeStarted === undefined && manifest.status === 'prepared');
      if (!neverStarted || manifest.status === 'applied' || manifest.entries.some((entry) => entry.done)) {
        throw failure('TRANSACTION_NOT_CANCELLABLE', 'Transaction may have written targets; manual conflict resolution is required');
      }
      manifest.status = 'cancelled';
      manifest.cancelledAt = now();
      manifest.cancellationReason = reason;
      await save(pathname, manifest, stored.version);
      return manifest;
    });
  }

  return {
    loadJob, saveJob, updateJob, loadDreamResult, saveDreamResult, appendDream, appendRejected, commit, recover, cancelUnwritten,
    async listJobs() {
      const entries = await files.list(path('jobs'));
      return Promise.all(entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
        .map(async (entry) => (await loadJob(decodeURIComponent(entry.name.slice(0, -5))))!));
    },
    async listTransactions() {
      const entries = await files.list(path('transactions'));
      const records = await Promise.all(entries.filter((entry) => entry.isDirectory)
        .map((entry) => load(path('transactions', entry.name, 'manifest.json'))));
      return records.filter(record => record !== null).map(({ value }) => {
        validateManifest(value, value.transactionId as string);
        return value;
      });
    },
    // Rejection JSON is only interpreted by wasRejected, which validates each review.
    async listRejected() {
      const entries = await files.list(path('rejected'));
      return Promise.all(entries.filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
        .map(async (entry) => (await load(path('rejected', entry.name)))!.value as unknown as { schemaVersion: 1; review: Review; proposal: Proposal }));
    },
  };
}
