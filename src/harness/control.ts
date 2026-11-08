import { randomUUID } from 'node:crypto';

import type { HostContext, Agent } from './types.js';
import type { HostControl, Metadata } from '../types.js';
import type { InternalTurnCompletion } from './internal-turns.js';

/** Inbox delivery is distinct from the later structured acknowledgement. */
export function createHostControl(ctx: HostContext, agent: Agent, options: { completion?: InternalTurnCompletion } = {}): HostControl {
  function send(text: string, metadata: Metadata = {}) {
    if (typeof agent.followup !== 'function') throw new Error('Harness followup unavailable');
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('Notification must be nonempty text');
    const { messageId = randomUUID(), ...source } = metadata;
    const message = { id: messageId, role: 'user' as const, content: [{ type: 'text' as const, text }], source: { kind: 'dsh-dream', ...source } };
    // Register exact content/source before followup can synchronously claim it.
    // A matching source label alone never authorizes silent completion.
    options.completion?.expect(message);
    agent.followup(message);
    return messageId;
  }
  async function waitForIdle(signal?: AbortSignal) {
    if (typeof agent.whenIdle !== 'function') throw new Error('Harness idle wait unavailable');
    signal?.throwIfAborted();
    const idle = agent.whenIdle();
    if (!signal) await idle;
    else await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error('Idle wait cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(idle).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
    signal?.throwIfAborted();
  }
  function contextPressure(): {
    totalTokens?: number; contextWindow?: number; baseline?: 'none' | 'estimated' | 'usage';
    provider?: string; model?: string; logRevision?: number; unavailableReason?: string;
  } {
    const result: ReturnType<typeof contextPressure> = {};
    const reasons: string[] = [];
    const record = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const name = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;

    // Optional lookup avoids an undeclared injected service and never estimates locally.
    try {
      const meter = ctx.get?.('tokenMeter');
      if (typeof meter?.measure !== 'function') reasons.push('Token meter unavailable');
      else {
        const measurement = record(meter.measure(agent.session));
        if (number(measurement.totalTokens)) result.totalTokens = measurement.totalTokens;
        else reasons.push('Token total unavailable or invalid');
        if (number(measurement.logRevision)) result.logRevision = measurement.logRevision;
        else reasons.push('Token measurement revision unavailable or invalid');
        const baseline = record(measurement.baseline).kind;
        if (baseline === 'none' || baseline === 'estimated' || baseline === 'usage') result.baseline = baseline;
        else reasons.push('Token baseline unavailable or invalid');
      }
    } catch { reasons.push('Token measurement unavailable: Host lookup or measurement failed'); }

    // The logged envelope is what measure(session) prices. request/context belongs
    // to that prepared route. Creation options may differ after routing middleware;
    // they are fallback metadata, never a veto over a matching logged request.
    try {
      const context = record(agent.session.requestContext?.());
      const header = record(agent.session.requestHeader?.()?.config);
      const options = record(agent.options);
      const provider = name(context.provider);
      const model = name(context.model);
      const routedProvider = name(header.provider) ?? provider ?? name(options.provider);
      const routedModel = name(header.model) ?? model ?? name(options.model);
      if (routedProvider !== undefined) result.provider = routedProvider;
      if (routedModel !== undefined) result.model = routedModel;
      const mismatch = (name(header.provider) !== undefined && name(header.provider) !== provider)
        || (name(header.model) !== undefined && name(header.model) !== model);
      if (!provider || !model) reasons.push('Request context route unavailable or invalid');
      else if (mismatch) reasons.push('Context window unavailable: request route mismatch');
      else if (number(context.contextWindow) && context.contextWindow > 0) result.contextWindow = context.contextWindow;
      else reasons.push('Context window unavailable or invalid');
    } catch { reasons.push('Context window unavailable: Host request route lookup failed'); }

    if (reasons.length) result.unavailableReason = reasons.join('; ');
    return result;
  }
  return {
    contextPressure,
    async notify(text, options = {}) { return send(text, { purpose: 'report', ...options }); },
    async requestReview(text, options = {}) { return send(text, { purpose: 'review', ...options }); },
    async requestReload(text, options = {}) { return send(text, { purpose: 'reload', ...options }); },
    waitForIdle,
    async maintain(task, signal) {
      if (typeof agent.runMaintenance !== 'function') throw new Error('Harness maintenance unavailable');
      await waitForIdle(signal);
      return agent.runMaintenance(async maintenanceSignal => {
        const combined = signal ? AbortSignal.any([signal, maintenanceSignal]) : maintenanceSignal;
        combined.throwIfAborted();
        return task(combined);
      });
    },
    async compact(signal) {
      if (typeof ctx.compaction?.compactNow !== 'function') throw new Error('Harness compaction unavailable');
      // compactNow owns runMaintenance; wrapping it in another maintenance deadlocks.
      await waitForIdle(signal);
      return ctx.compaction.compactNow(agent, signal ?? new AbortController().signal);
    },
  };
}
