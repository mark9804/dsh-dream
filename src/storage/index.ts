import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { validateChangeSet, validateJob, validateSnapshot } from '../domain/contracts.js';
import { assertChangeBudget, DEFAULT_CHANGE_BUDGET } from '../domain/budgets.js';
import type { ChangeBudget } from '../domain/budgets.js';
import { candidateView } from '../dream/lineage.js';
import { validateEpisodeDigest } from '../dream/episodes.js';
import { MAX_GENERATION_ATTEMPT_BYTES, validateGenerationAttempt } from '../domain/generation-attempt.js';
import type { GenerationAttempt } from '../domain/generation-attempt.js';

import type { Files, Version, Job, DreamResult, Review, Proposal, Manifest, ChangeSet, AfterStep, ReloadSource, ManifestEntry, ReinforcementControl, OriginalSourceVerifier, Scope } from '../types.js';

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
export function createStore(files: Files, { root = 'state', lockKey, now = () => new Date().toISOString(), changeBudget = DEFAULT_CHANGE_BUDGET, verifyOriginal }: { root?: string; lockKey?: string; now?: () => string; changeBudget?: ChangeBudget; verifyOriginal?: OriginalSourceVerifier } = {}) {
  if (!files || (['read', 'write', 'mkdir', 'list', 'withLock'] as const).some((name) => typeof files[name] !== 'function')) {
    throw new TypeError('The storage adapter must provide files and a memory-root lock');
  }
  key(lockKey);
  if (typeof root !== 'string' || !root || root.split('/').includes('..')) throw new TypeError('Invalid state root');
  const path = (...parts: string[]) => posix.join(root, ...parts);
  const jobPath = (id: string) => path('jobs', `${key(id)}.json`);
  const dreamResultPath = (id: string) => path('dreams', 'results', `${key(id)}.json`);
  const transactionPath = (id: string) => path('transactions', key(id), 'manifest.json');
  const generationAttemptPath = (id: string) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) throw new TypeError('Generation attempt needs a UUID');
    return path('attempts', `${id}.json`);
  };
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

  function preserveHistory(previous: Job | null, next: Job) {
    const before = previous?.transactionHistory ?? [];
    const after = next.transactionHistory ?? [];
    if (!previous) {
      if (after.length || next.transactionWriteReceipt) throw failure('TRANSACTION_HISTORY_CONFLICT', 'New jobs cannot invent acknowledged history or write receipts');
      return;
    }
    const conflict = (message: string) => { throw failure('TRANSACTION_HISTORY_CONFLICT', message); };
    if (!isDeepStrictEqual(previous.transactionWriteReceipt, next.transactionWriteReceipt) &&
      (next.transactionWriteReceipt !== undefined || previous.transaction?.transactionId === next.transaction?.transactionId)) conflict('Transaction write receipts can only be recorded by storage completion');
    for (const field of ['appliedProposalIds', 'appliedTransactionIds', 'invalidatedReviewIds'] as const) {
      const oldIds = previous[field] ?? [], newIds = next[field] ?? [];
      if (oldIds.some((id, index) => newIds[index] !== id)) conflict(`${field} is append-only`);
    }
    if (before.length > after.length || before.some((entry, index) => !isDeepStrictEqual(entry, after[index]))) conflict('Acknowledged transaction history is append-only');
    // Freeze the interpretations referenced by history as well as its own entries.
    // Otherwise rewriting an old review/basis could change what an unchanged ID means.
    for (const entry of after) {
      for (const id of entry.transaction.proposalIds) {
        if (!isDeepStrictEqual(previous.proposals.find(item => item.proposalId === id), next.proposals.find(item => item.proposalId === id))) conflict('Historical transaction proposal is immutable');
      }
      for (const id of entry.transaction.reviewIds) {
        if (!isDeepStrictEqual(previous.reviews.find(item => item.reviewId === id), next.reviews.find(item => item.reviewId === id))) conflict('Historical transaction review and basis are immutable');
      }
    }
    const appended = after.slice(before.length);
    if (!appended.length) return;
    if (appended.length !== 1 || previous.state !== 'awaiting_reload' || previous.reload?.status !== 'ready' || previous.reload.acknowledgedAt || !previous.transaction) conflict('Transaction history can be appended only by a fresh reload acknowledgement');
    const entry = appended[0];
    if (!isDeepStrictEqual(previous.scope, next.scope) || !isDeepStrictEqual(previous.transaction, next.transaction) ||
      !isDeepStrictEqual(entry.transaction, { ...previous.transaction, status: 'applied' }) ||
      !isDeepStrictEqual(entry.reload, next.reload) ||
      !isDeepStrictEqual({ ...entry.reload, acknowledgedAt: undefined }, { ...previous.reload, acknowledgedAt: undefined }) ||
      !['awaiting_review', 'completed'].includes(next.state) ||
      !isDeepStrictEqual(previous.appliedProposalIds, next.appliedProposalIds) ||
      !isDeepStrictEqual(previous.appliedTransactionIds, next.appliedTransactionIds)) conflict('New transaction history must bind the current transaction, reload and applied ledgers');
    const receipt = previous.transactionWriteReceipt;
    const expectedWritten = receipt?.transactionId === entry.transaction.transactionId && receipt.sources.every(written => entry.reload.sources.some(source => isDeepStrictEqual(source, written))) ? receipt.sources : undefined;
    if (!isDeepStrictEqual(entry.writtenSources, expectedWritten)) conflict('Transaction history written sources must come from matching storage write receipts');
  }

  async function saveJob(job: Job) {
    // Detach before awaiting the storage lock so a caller cannot mutate guarded history.
    const next = structuredClone(validateJob(job));
    return locked(async () => {
      const pathname = jobPath(next.jobId);
      const stored = await load(pathname);
      preserveHistory(stored ? validateJob(stored.value) : null, next);
      await save(pathname, next, stored?.version ?? null);
      return next;
    });
  }

  async function updateJob(jobId: string, updater: (job: Job) => Job | Promise<Job>) {
    return locked(async () => {
      const pathname = jobPath(jobId);
      const stored = await load(pathname);
      if (!stored) throw failure('JOB_NOT_FOUND', 'Cannot update a missing job');
      validateJob(stored.value);
      const next = structuredClone(await updater(structuredClone(validateJob(stored.value))));
      validateJob(next);
      if (next.jobId !== jobId) throw new TypeError('Cannot change the job id');
      preserveHistory(validateJob(stored.value), next);
      await save(pathname, next, stored.version);
      return next;
    });
  }

  /** Private rejected output archive; never read by proposal/review generation. */
  async function loadGenerationAttempt(attemptId: string, expectedScope?: Scope) {
    const stored = await files.read(generationAttemptPath(attemptId), { maxBytes: MAX_GENERATION_ATTEMPT_BYTES });
    if (!stored) return null;
    if (Buffer.byteLength(stored.content) > MAX_GENERATION_ATTEMPT_BYTES) throw new RangeError('Generation attempt exceeds archive budget');
    const attempt = validateGenerationAttempt(JSON.parse(stored.content));
    if (attempt.attemptId !== attemptId || expectedScope && !isDeepStrictEqual(attempt.scope, expectedScope)) throw failure('GENERATION_ATTEMPT_CONFLICT', 'Generation attempt identity or scope mismatch');
    return attempt;
  }

  async function saveGenerationAttempt(input: GenerationAttempt): Promise<string> {
    const attempt = structuredClone(validateGenerationAttempt(input));
    const pathname = generationAttemptPath(attempt.attemptId);
    const content = `${JSON.stringify(attempt)}\n`;
    return locked(async () => {
      const previous = await files.read(pathname, { maxBytes: MAX_GENERATION_ATTEMPT_BYTES });
      if (previous) {
        if (previous.content !== content) throw failure('GENERATION_ATTEMPT_CONFLICT', 'Generation attempt archive is immutable');
        return pathname;
      }
      const job = await loadJob(attempt.jobId);
      if (!job || job.state !== 'generating' || job.snapshot.snapshotId !== attempt.snapshotId || !isDeepStrictEqual(job.scope, attempt.scope)
        || job.generationDiagnostics?.attemptId !== attempt.attemptId || job.generationDiagnostics.mode !== attempt.mode) {
        throw failure('GENERATION_ATTEMPT_CONFLICT', 'Generation attempt owner changed');
      }
      await files.mkdir(posix.dirname(pathname));
      await files.write(pathname, content, null);
      return pathname;
    });
  }

  function validateDreamResult(record: { schemaVersion?: unknown; jobId?: unknown; result?: unknown }, jobId: string): DreamResult {
    if (record.schemaVersion !== 1 || record.jobId !== jobId) throw new TypeError('Stored dream result identity or version is invalid');
    const result = record.result as DreamResult | undefined; // Candidate validated below; proposals are checked against the job before use.
    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.proposals)) throw new TypeError('Invalid stored generation result');
    if (result.mode === 'memory-v2') {
      if (!result.digest || 'dream' in result) throw new TypeError('Memory result cannot contain a creative dream');
    } else if (typeof result.dream !== 'string' || !result.dream.trim()) throw new TypeError('Invalid stored dream result');
    return result;
  }

  async function loadDreamResult(jobId: string) {
    const stored = await load(dreamResultPath(jobId));
    if (!stored) return null;
    const result = validateDreamResult(stored.value, jobId);
    if (result.mode === 'memory-v2') {
      // The job snapshot changes after review/application; use the immutable
      // generation snapshot to validate old event evidence and identity.
      validateEpisodeDigest(result.digest, validateSnapshot(stored.value.snapshot));
    }
    return result;
  }

  /** Save once so retries cannot pair an earlier dream with different proposals. */
  async function saveDreamResult(jobId: string, result: DreamResult) {
    const pathname = dreamResultPath(jobId);
    const record = { schemaVersion: 1, jobId, result: structuredClone(result) };
    validateDreamResult(record, jobId);
    return locked(async () => {
      if (result.mode === 'memory-v2') {
        const job = await loadJob(jobId); if (!job) throw new Error('Memory result requires its job snapshot');
        validateEpisodeDigest(result.digest, job.snapshot);
        Object.assign(record, { snapshot: structuredClone(job.snapshot) });
      }
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
    if (manifest.budget !== undefined && (!Number.isSafeInteger(manifest.budget.maxChangeBytes) || manifest.budget.maxChangeBytes <= 0 || !Number.isSafeInteger(manifest.budget.maxPromotions) || manifest.budget.maxPromotions <= 0)) throw new TypeError('Invalid transaction budget');
    validateChangeSet(manifest.changeSet);
    if (manifest.changeSet.transactionId !== transactionId || manifest.jobId !== manifest.changeSet.jobId || manifest.entries.length !== manifest.changeSet.changes.length) {
      throw new TypeError('Transaction entries do not match the change set');
    }
    for (const [index, entry] of manifest.entries.entries()) {
      const change = manifest.changeSet.changes[index];
      if (entry.writtenVersion !== undefined) {
        // Reuse JSON version validation without pretending a returned version is a new edit.
        validateChangeSet({ ...manifest.changeSet, changes: [{ ...change, version: entry.writtenVersion }] });
        if (entry.writtenVersion === null) throw new TypeError('A written file receipt cannot have a missing-file version');
      }
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
    // Only actual write-return versions are receipts. Recovery that merely finds
    // an after-image must not infer a version that the original writer never saved.
    if (job.transaction?.transactionId === manifest.transactionId && manifest.entries.every(entry => entry.writtenVersion !== undefined)) {
      job.transactionWriteReceipt = { transactionId: manifest.transactionId,
        sources: manifest.entries.map(entry => ({ sourceId: entry.targetId, path: entry.path, content: entry.after, version: entry.writtenVersion! })) };
    }
    job.state = 'applied';
    job.updatedAt = manifest.appliedAt!;
    delete job.phase;
    delete job.checkpoint;
    delete job.error;
    validateJob(job);
    await save(pathname, job, stored.version);
  }

  async function listJobs() {
    const entries = await files.list(path('jobs'));
    return Promise.all(entries.filter(entry => !entry.isDirectory && entry.name.endsWith('.json'))
      .map(async entry => (await loadJob(decodeURIComponent(entry.name.slice(0, -5))))!));
  }

  async function requireCurrentOriginals(job: Job) {
    for (const source of job.snapshot.sources) for (const expected of source.originals ?? []) {
      if (expected.status !== 'verified') continue;
      if (!verifyOriginal) throw failure('ORIGINAL_SOURCE_UNVERIFIED', 'Original-source verifier unavailable before commit');
      const actual = await verifyOriginal(expected.ref);
      if (!isDeepStrictEqual(actual, expected)) throw failure('ORIGINAL_SOURCE_CONFLICT', 'Original-source receipt changed before commit');
    }
  }

  async function requireCurrentCandidates(job: Job, changeSet: ChangeSet) {
    const view = job.snapshot.candidates;
    if (!view) return;
    const history = (await listJobs()).filter(j => j.jobId !== job.jobId);
    const current = candidateView(history, job.scope, view.items.length);
    if (!isDeepStrictEqual(current, view)) throw failure('CANDIDATE_CONFLICT', 'Candidate history changed after review; request a fresh isolated review before writing');
    // Explicitly selected candidate references are also checked by validateChangeSet.
    void changeSet;
  }

  /** Re-authorize the original input, not after-images observed during recovery. */
  async function requireCleanManifest(manifest: Manifest) {
    try {
      const job = await loadJob(manifest.jobId);
      if (!job) throw new TypeError('Transaction has no stored review job');
      const reviews = manifest.changeSet.reviewIds.map(id => job.reviews.find(review => review.reviewId === id));
      if (reviews.some(review => !review?.authority)) throw new TypeError('Transaction has no clean model acceptance');
      // Once writing starts, retain the budget admitted for this transaction;
      // changing next-batch policy must not strand a partially applied batch.
      assertChangeBudget(manifest.changeSet.proposalIds.map(id => job.proposals.find(p => p.proposalId === id)!), manifest.writeStarted ? manifest.budget ?? changeBudget : changeBudget);
      if (!manifest.writeStarted && !manifest.entries.some(e => e.done)) await requireCurrentCandidates(job, manifest.changeSet);
      const original = reviews[0]!.basis;
      await requireCurrentOriginals({ ...job, snapshot: { ...job.snapshot, sources: original.sources } });
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
        snapshot: { ...job.snapshot, scope: original.scope, sources: original.sources, candidates: original.candidates, originalCoverage: original.originalCoverage },
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
        entry.writtenVersion = await files.write(entry.path, entry.after, manifest.changeSet.changes[index].version);
        // Persist the returned version before the test/recovery hook can interrupt.
        // If this save itself fails, recovery must leave continuity unproven.
        version = await save(pathname, manifest, version);
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
      await requireCurrentCandidates(job, changeSet);
      await requireCurrentOriginals(job);
      assertChangeBudget(changeSet.proposalIds.map(id => job.proposals.find(p => p.proposalId === id)!), changeBudget);
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
        status: 'prepared', writeStarted: false, budget: { maxChangeBytes: changeBudget.maxChangeBytes, maxPromotions: changeBudget.maxPromotions }, changeSet: structuredClone(changeSet), entries, sources };
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
    loadJob, saveJob, updateJob, loadDreamResult, saveDreamResult, loadGenerationAttempt, saveGenerationAttempt, appendDream, appendRejected, commit, recover, cancelUnwritten,
    async loadGenerationSnapshot(jobId: string) { const stored = await load(dreamResultPath(jobId)); return stored?.value.snapshot ? validateSnapshot(stored.value.snapshot) : null; },
    listJobs,
    async setReinforcement(control: ReinforcementControl) {
      if (!control || !control.actor || !control.scope) throw new TypeError('Invalid reinforcement control');
      if (control.schemaVersion !== 1 || typeof control.candidateId !== 'string' || !control.candidateId.trim() || typeof control.enabled !== 'boolean' || !control.reason?.trim() || !Number.isFinite(Date.parse(control.at)) || control.actor.agentId !== control.scope.agentId || control.actor.sessionId !== control.scope.sessionId) throw new TypeError('Invalid reinforcement control');
      return locked(async () => {
        const pathname = path('reinforcement', `${key(control.scope.scopeId)}-${key(control.candidateId)}.json`);
        const old = await load(pathname);
        if (old && !isDeepStrictEqual(old.value.scope, control.scope)) throw failure('SCOPE_CONFLICT', 'Reinforcement control belongs to another scope');
        await save(pathname, control, old?.version ?? null);
        return control;
      });
    },
    async listReinforcement(scope: Scope): Promise<ReinforcementControl[]> {
      const entries = await files.list(path('reinforcement'));
      const records = await Promise.all(entries.filter(e => !e.isDirectory && e.name.endsWith('.json')).map(e => load(path('reinforcement', e.name))));
      return records.filter(r => r && isDeepStrictEqual(r.value.scope, scope)).map(r => r!.value as unknown as ReinforcementControl);
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
