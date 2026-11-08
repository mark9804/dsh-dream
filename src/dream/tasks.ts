import type { Snapshot, DreamConfig } from '../types.js';
import { errorFields } from '../types.js';
import { validateEpisodeDigest } from './episodes.js';
import type { EpisodeDigest } from './episodes.js';
import type { FreeDreamInput } from './free-narrative.js';
import { validateFreeDreamInput } from './free-narrative.js';
import type { DreamConversation } from '../harness/dream-context.js';
import type { DreamWriter } from './free-executor.js';
import type { createNarrativeStore, NarrativeTask } from '../storage/narratives.js';
import { narrativeAttemptActive, releaseNarrativeAttempt } from '../storage/narratives.js';
interface TaskOptions {
  store: ReturnType<typeof createNarrativeStore>; config: Pick<DreamConfig, 'dreamMode' | 'dreamTimeoutMs' | 'dreamMood'>;
  writer: DreamWriter; context: (snapshot: Snapshot, digest: EpisodeDigest, options?: { signal?: AbortSignal }) => Promise<DreamConversation>;
  publish(task: NarrativeTask): Promise<string>; signal?: AbortSignal; now?: () => Date; onError?: (error: unknown) => void;
}
/** Non-authoritative narrative queue. start never gates memory review/application;
 * all work, including history/context acquisition, owns its own cancellation. */
export function createDreamTasks({ store, config, writer, context, publish, signal, now = () => new Date(), onError }: TaskOptions) {
  const pending = new Map<string, Promise<void>>();
  let stopped = false;
  const controllers = new Set<AbortController>();
  function launch(jobId: string, work: () => Promise<void>) {
    if (stopped || signal?.aborted || pending.has(jobId)) return;
    const task = Promise.resolve().then(work).catch(onError ?? (() => {})).finally(() => pending.delete(jobId));
    pending.set(jobId, task);
  }
  async function run(jobId: string, operationSignal?: AbortSignal) {
    let task = await store.claim(jobId); if (!task) return;
    try {
      operationSignal?.throwIfAborted();
      if (!task.output) {
        const output = await writer(task.input!, { signal: operationSignal });
        operationSignal?.throwIfAborted();
        task = await store.result(jobId, task.attemptId!, output);
      }
      operationSignal?.throwIfAborted();
      const current = await store.get(jobId);
      if (current?.state !== 'generating' || current.attemptId !== task.attemptId) throw new Error('Obsolete dream publication');
      operationSignal?.throwIfAborted();
      const dreamPath = await publish(task);
      await store.complete(jobId, task.attemptId!, dreamPath);
    } catch (error) { await store.fail(jobId, { code: errorFields(error).code ?? 'DREAM_FAILED', message: errorFields(error).message ?? String(error) }, task.attemptId); }
    finally { releaseNarrativeAttempt(task.attemptId!); }
  }
  async function owned(jobId: string, work: (operationSignal: AbortSignal) => Promise<void>) {
    const controller = new AbortController(); controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Independent dream task timed out'), { code: 'DREAM_TIMEOUT' })), config.dreamTimeoutMs);
    try { combined.throwIfAborted(); await work(combined); }
    finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function start(snapshot: Snapshot, digest: EpisodeDigest, jobId: string, date: string) {
    // Detach caller-owned snapshots before any asynchronous queue delay.
    const frozenSnapshot = structuredClone(snapshot), frozenDigest = structuredClone(digest);
    launch(jobId, () => owned(jobId, async operationSignal => {
      try {
        const existing = await store.get(jobId);
        if (existing) { if (existing.state === 'queued' && config.dreamMode !== 'off') await run(jobId, operationSignal); return; }
        if (config.dreamMode === 'off') { await store.create(jobId, undefined, date, 'disabled'); return; }
        validateEpisodeDigest(frozenDigest, frozenSnapshot);
        const conversation = await context(frozenSnapshot, frozenDigest, { signal: operationSignal });
        operationSignal.throwIfAborted();
        const input: FreeDreamInput = { schemaVersion: 1, jobId, snapshotId: frozenSnapshot.snapshotId, episodes: frozenDigest, conversation,
          ...(config.dreamMood ? { mood: structuredClone(config.dreamMood) } : {}) };
        validateFreeDreamInput(input);
        await store.create(jobId, input, date, 'queued', undefined, (frozenSnapshot.sources.some(s => s.sensitivity === 'sensitive') || conversation.messages.some(m => /<!--\s*sensitive\s*-->/i.test(m.text)) || /<!--\s*sensitive\s*-->/i.test(config.dreamMood?.text ?? '')));
        await run(jobId, operationSignal);
      } catch (error) {
        const detail = { code: errorFields(error).code ?? 'DREAM_INPUT_FAILED', message: errorFields(error).message ?? String(error) };
        // Preparation has no attempt ownership. A second instance may already
        // own this job; never mark its active inference failed from our catch.
        if (!await store.get(jobId)) await store.create(jobId, undefined, date, 'failed', detail, frozenSnapshot.sources.some(s => s.sensitivity === 'sensitive'));
        else onError?.(error);
      }
    }));
  }
  return {
    start,
    async status(jobId: string) { const task = await store.get(jobId); return task && { state: task.state, attempts: task.attempts, inputDigest: task.inputDigest, dreamPath: task.dreamPath, error: task.error, afterFeeling: task.output?.afterFeeling, contextCoverage: task.input?.conversation.coverage }; },
    async retry(jobId: string, basis?: { snapshot: Snapshot; digest: EpisodeDigest }) {
      if (stopped || signal?.aborted) throw new Error('Independent dreaming stopped');
      if (config.dreamMode === 'off') throw new Error('Independent dreaming is disabled');
      if (pending.has(jobId)) throw new Error('Independent dream still running; wait for actual drainage');
      const old = await store.get(jobId);
      if (old?.state === 'failed' && !old.input) {
        if (!basis) throw new Error('Dream preparation retry requires its frozen generation snapshot');
        const snapshot = structuredClone(basis.snapshot), digest = structuredClone(basis.digest);
        validateEpisodeDigest(digest, snapshot);
        launch(jobId, () => owned(jobId, async op => {
          try {
            const conversation = await context(snapshot, digest, { signal: op }); op.throwIfAborted();
            const input = validateFreeDreamInput({ schemaVersion: 1, jobId, snapshotId: snapshot.snapshotId, episodes: digest, conversation, ...(config.dreamMood ? { mood: structuredClone(config.dreamMood) } : {}) });
            await store.prepareRetry(jobId, input, snapshot.sources.some(s => s.sensitivity === 'sensitive') || conversation.messages.some(m => /<!--\s*sensitive\s*-->/i.test(m.text)) || /<!--\s*sensitive\s*-->/i.test(config.dreamMood?.text ?? '')); await run(jobId, op);
          } catch (error) { onError?.(error); }
        }));
      } else { await store.retry(jobId); launch(jobId, () => owned(jobId, op => run(jobId, op))); }
      return { jobId, branch: 'dream', queued: true };
    },
    async resume() {
      if (stopped || signal?.aborted) return;
      for (const task of await store.list()) {
        if (config.dreamMode === 'off' && ['queued', 'generating'].includes(task.state)) { await store.disable(task.jobId); continue; }
        if (task.state === 'queued') launch(task.jobId, () => owned(task.jobId, op => run(task.jobId, op)));
        else if (task.state === 'generating' && task.output) {
          launch(task.jobId, () => owned(task.jobId, async op => {
            const ownedTask = await store.reclaimPublication(task.jobId); if (!ownedTask) return;
            try {
              op.throwIfAborted(); const current = await store.get(task.jobId);
              if (current?.state !== 'generating' || current.attemptId !== ownedTask.attemptId) return;
              op.throwIfAborted();
              const dreamPath = await publish(ownedTask); await store.complete(task.jobId, ownedTask.attemptId!, dreamPath);
            }
            catch (error) { await store.fail(task.jobId, { code: errorFields(error).code ?? 'DREAM_PUBLICATION_FAILED', message: errorFields(error).message ?? String(error) }, ownedTask.attemptId); }
            finally { releaseNarrativeAttempt(ownedTask.attemptId!); }
          }));
        } else if (task.state === 'generating') {
          // Never infer an interrupted provider call's outcome or redraw on resume.
          let dead = task.ownerPid === process.pid && !narrativeAttemptActive(task.attemptId);
          if (task.ownerPid !== process.pid) try { process.kill(task.ownerPid!, 0); } catch (error) { dead = errorFields(error).code === 'ESRCH'; }
          if (dead) await store.fail(task.jobId, { code: 'DREAM_INTERRUPTED', message: 'Previous dream owner stopped before recording an output; explicit dream retry required' }, task.attemptId);
        }
      }
    },
    stop(reason = new Error('Independent dreaming stopped')) { stopped = true; for (const controller of controllers) controller.abort(reason); },
    async flush() { while (pending.size) await Promise.allSettled([...pending.values()]); },
  };
}
export type DreamTasks = ReturnType<typeof createDreamTasks>;
