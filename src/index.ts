import { validateConfig } from './config.js';
import { createEngine } from './engine.js';
import { createStore } from './storage/index.js';
import { createWorkerGenerator } from './scheduler/executor.js';
import { createController } from './scheduler/controller.js';
import { createHostFiles } from './harness/files.js';
import { createHostModel } from './harness/model.js';
import { createCleanReviewer } from './harness/clean-review.js';
import { createHostControl } from './harness/control.js';
import { registerTools } from './harness/tools.js';

import type { HostContext, Agent } from './harness/types.js';
interface Instance { agent: Agent; abort: AbortController; controller: ReturnType<typeof createController>; engine: ReturnType<typeof createEngine>; removeTools: () => void }

export { Config } from './config.js';
export const inject = ['agents', 'fs', 'llm', 'compaction', 'tools'];

/** Bind one explicitly configured session; Cordis owns listeners and cleanup. */
export function apply(ctx: HostContext, input: unknown) {
  const config = validateConfig(input);
  if (typeof ctx.effect !== 'function' || typeof ctx.on !== 'function' || typeof ctx.agents?.get !== 'function') {
    throw new Error('Harness lifecycle or agent registry unavailable');
  }
  return ctx.effect(() => {
    let active: Instance | undefined;
    let disposed = false;
    const retiring = new Set<Promise<unknown>>();

    function retire(instance: Instance | undefined) {
      if (!instance) return;
      instance.abort.abort(new Error('Dream plugin or target agent stopped'));
      instance.controller.stop();
      instance.removeTools();
      const cleanup = Promise.all([instance.controller.flush(), instance.engine.flush()])
        .catch(error => ctx.logger?.error(error)).finally(() => retiring.delete(cleanup));
      retiring.add(cleanup);
    }

    function bind(agent: Agent | undefined) {
      if (disposed || !agent || agent.id !== config.sessionId || agent.session?.id !== config.sessionId || active?.agent === agent) return;
      retire(active);
      active = undefined;
      const abort = new AbortController();
      const serviceContext = ctx;
      const files = createHostFiles(serviceContext, agent, { roots: config, signal: abort.signal });
      const host = createHostControl(serviceContext, agent);
      const model = createHostModel(serviceContext, agent, config);
      const store = createStore(files, { root: config.stateRoot, lockKey: config.memoryRoot });
      const scope = { scopeId: config.sessionId, agentId: agent.id, sessionId: agent.session.id, memoryRootId: config.memoryRoot };
      const engine = createEngine({ config, scope, files, store, host, signal: abort.signal,
        generate: createWorkerGenerator(model, config), cleanReview: createCleanReviewer(serviceContext, agent, config), generationLock: task => files.withGenerationLock(task) });
      const controller = createController({ config, engine, host, signal: abort.signal });
      const removeTools = registerTools(agent, {
        status: engine.status,
        ...(config.compactionMode === 'agent' ? { decideCompaction: engine.decideCompaction } : {}),
        review: engine.review,
        submit: engine.submit,
        ackReload: engine.ackReload,
        retry: (args, execution) => engine.retry(args, { ...execution, signal: controller.generationSignal() }),
      }, serviceContext);
      active = { agent, abort, controller, engine, removeTools };
      controller.start();
    }

    const offCreated = ctx.on('agent/created', ({ agent }) => { bind(agent); });
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
      if (active?.agent !== agent) return;
      retire(active);
      active = undefined;
    });
    try { bind(ctx.agents.get(config.sessionId)); }
    catch (error) { offCreated(); offDisposed(); retire(active); throw error; }
    return async () => {
      if (disposed) return;
      disposed = true;
      offCreated();
      offDisposed();
      retire(active);
      active = undefined;
      await Promise.all([...retiring]);
    };
  });
}
