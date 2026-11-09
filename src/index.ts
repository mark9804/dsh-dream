import { validateConfig } from './config.js';
import { createEngine } from './engine.js';
import { createStore } from './storage/index.js';
import { createWorkerGenerator } from './scheduler/executor.js';
import { createController } from './scheduler/controller.js';
import { createHostFiles } from './harness/files.js';
import { createHostModel } from './harness/model.js';
import { createModelSelectionTracker } from './harness/model-selection.js';
import { createRuntimeContext } from './harness/runtime-context.js';
import { createCleanReviewer } from './harness/clean-review.js';
import { createHostControl } from './harness/control.js';
import { registerTools } from './harness/tools.js';
import { createInternalTurnCompletion } from './harness/internal-turns.js';
import { createOriginalSourceVerifier } from './harness/original-source.js';
import { createDreamContextReader } from './harness/dream-context.js';
import { createNarrativeStore } from './storage/narratives.js';
import { createFreeDreamWriter } from './dream/free-executor.js';
import { createDreamTasks } from './dream/tasks.js';
import { createSettledCleanup } from './harness/lifecycle.js';

import type { HostContext, Agent } from './harness/types.js';
interface Instance { agent: Agent; abort: AbortController; controller: ReturnType<typeof createController>; engine: ReturnType<typeof createEngine>; narratives: ReturnType<typeof createDreamTasks>; removeTools: () => void; stopInternalCompletion: () => void; stopModelSelection: () => void }

export { Config } from './config.js';
export const inject = ['agents', 'fs', 'llm', 'tools', 'sandboxPolicy'];
export interface RuntimeObserver { bind?(engine: ReturnType<typeof createEngine>, agent: Agent): void; unbind?(agent: Agent): void; beforeBind?(agent: Agent): Promise<void>; failed?(error: unknown): void }

/** Bind one explicitly configured session; Cordis owns listeners and cleanup. */
export function apply(ctx: HostContext, input: unknown, observer?: RuntimeObserver) {
  const config = validateConfig(input);
  if (typeof ctx.effect !== 'function' || typeof ctx.on !== 'function' || typeof ctx.agents?.get !== 'function') {
    throw new Error('Harness lifecycle or agent registry unavailable');
  }
  return ctx.effect(() => {
    let active: Instance | undefined;
    let disposed = false;
    const retiring = new Set<Promise<unknown>>();
    const retirements = new WeakMap<Instance, () => Promise<void>>();
    const reportingErrors: unknown[] = [];
    let bindingRevision = 0;

    function retire(instance: Instance | undefined) {
      if (!instance) return;
      const existing = retirements.get(instance);
      if (existing) { existing(); return; }
      const drain = createSettledCleanup([
        () => instance.stopInternalCompletion(),
        () => instance.stopModelSelection(),
        () => observer?.unbind?.(instance.agent),
        () => instance.abort.abort(new Error('Dream plugin or target agent stopped')),
        () => instance.controller.stop(),
        () => instance.narratives.stop(),
        () => instance.removeTools(),
        () => instance.controller.flush(),
        () => instance.engine.flush(),
        () => instance.narratives.flush(),
      ], 'Dream instance cleanup failed');
      // Register both gates before a synchronous disposer can reenter retirement
      // or plugin disposal. The tracking promise itself never rejects early.
      retirements.set(instance, drain);
      let settled!: () => void;
      const cleanup = new Promise<void>(resolve => { settled = resolve; });
      retiring.add(cleanup);
      void drain().catch(error => {
        // Reporting is not permission to skip another instance's pending drain.
        try { ctx.logger?.error(error); } catch (reportingError) { reportingErrors.push(reportingError); }
      }).finally(() => { retiring.delete(cleanup); settled(); });
    }

    function bind(agent: Agent | undefined) {
      if (disposed || !agent || agent.id !== config.sessionId || agent.session?.id !== config.sessionId || active?.agent === agent) return;
      retire(active);
      active = undefined;
      const abort = new AbortController();
      const serviceContext = createRuntimeContext(ctx, agent);
      if (typeof serviceContext.compaction?.compactNow !== 'function') throw new Error('Target session compaction backend unavailable in its retained composition');
      const files = createHostFiles(serviceContext, agent, { roots: config, signal: abort.signal });
      const completion = createInternalTurnCompletion(serviceContext, agent);
      const modelSelection = createModelSelectionTracker(serviceContext, agent);
      try {
      const host = createHostControl(serviceContext, agent, { completion });
      const memoryModel = createHostModel(serviceContext, agent, { ...config, modelChoice: config.memoryModel });
      const dreamModel = createHostModel(serviceContext, agent, { ...config, modelChoice: config.dreamModel });
      const originalVerifier = createOriginalSourceVerifier(serviceContext, config);
      const verifyOriginal: typeof originalVerifier = (ref, options) => originalVerifier(ref, { signal: options?.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal });
      const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot, changeBudget: config, verifyOriginal });
      const scope = { scopeId: config.sessionId, agentId: agent.id, sessionId: agent.session.id, memoryRootId: config.memoryRoot };
      // Cleanup must record settled cancellations even after bind abort. This
      // adapter retains current Host policy but not the disposed signal.
      const narrativeFiles = createHostFiles(serviceContext, agent, { roots: config });
      const narrativeStore = createNarrativeStore(narrativeFiles, { root: config.stateRoot, scope });
      const narrativeDiary = createStore(narrativeFiles, { root: config.stateRoot, lockKey: config.memoryRoot });
      const narratives = createDreamTasks({ store: narrativeStore, config, signal: abort.signal,
        context: createDreamContextReader(serviceContext, config),
        writer: createFreeDreamWriter(dreamModel, { timeoutMs: config.dreamTimeoutMs, maxOutputBytes: config.maxOutputBytes }),
        publish: async task => narrativeDiary.appendDream({ jobId: task.jobId, date: task.date,
          text: `${task.sensitive ? '<!-- sensitive -->\n' : ''}${task.output!.dream}${task.output!.afterFeeling ? `\n\n> 梦后感受（梦境衍生的暂时感受，不是事实或人格）：\n\n${task.output!.afterFeeling}` : ''}` }),
        onError: error => ctx.logger?.error(error) });
      const engine = createEngine({ config, scope, files, store, host, verifyOriginal, narratives, signal: abort.signal,
        generate: createWorkerGenerator(memoryModel, config, 'memory-v2'), cleanReview: createCleanReviewer(serviceContext, agent, { ...config, modelSelection: modelSelection.current, modelChoice: config.reviewModel }), generationLock: task => files.withGenerationLock(task) });
      const controller = createController({ config, engine, host, signal: abort.signal });
      const removeTools = registerTools(agent, {
        status: engine.status,
        recall: engine.recall,
        reinforcement: engine.reinforcement,
        ...(config.compactionMode === 'agent' ? { decideCompaction: engine.decideCompaction } : {}),
        review: engine.review,
        reviewBatch: engine.reviewBatch,
        readReload: engine.readReload,
        submit: engine.submit,
        ackReload: engine.ackReload,
        retry: (args, execution) => engine.retry(args, { ...execution, signal: controller.generationSignal() }),
      }, agent.ctx, { completion });
      active = { agent, abort, controller, engine, narratives, removeTools, stopInternalCompletion: completion.dispose, stopModelSelection: modelSelection.dispose };
      observer?.bind?.(engine, agent);
      controller.start();
      } catch (error) { completion.dispose(); modelSelection.dispose(); throw error; }
    }

    function admit(agent: Agent | undefined) {
      if (!agent || agent.id !== config.sessionId || disposed) return;
      if (!observer?.beforeBind) { bind(agent); return; }
      const revision = ++bindingRevision;
      const pending = observer.beforeBind(agent).then(() => {
        if (!disposed && revision === bindingRevision && ctx.agents.get(config.sessionId) === agent) bind(agent);
      }).catch(error => { observer.failed?.(error); ctx.logger?.error(error); }).finally(() => retiring.delete(pending));
      retiring.add(pending);
    }
    const offCreated = ctx.on('agent/created', ({ agent }) => { admit(agent); });
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      if (agent.id === config.sessionId) bindingRevision++;
      if (active?.agent !== agent) return;
      retire(active);
      active = undefined;
    });
    try { admit(ctx.agents.get(config.sessionId)); }
    catch (error) { offCreated(); offDisposed(); retire(active); throw error; }
    return createSettledCleanup([
      () => { disposed = true; bindingRevision++; },
      offCreated,
      offDisposed,
      () => { const instance = active; active = undefined; retire(instance); },
      async () => {
        const errors: unknown[] = [];
        while (retiring.size) {
          const results = await Promise.allSettled([...retiring]);
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        }
        errors.push(...reportingErrors);
        if (errors.length) throw new AggregateError(errors, 'Dream retirement reporting failed');
      },
    ], 'Dream plugin cleanup failed');
  });
}
