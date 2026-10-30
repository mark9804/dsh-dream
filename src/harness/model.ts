import type { HostContext, Agent, CallConfig } from './types.js';
import type { Model } from '../types.js';

/** Call only the model route already selected by the target Harness session. */
export function createHostModel(ctx: HostContext, agent: Agent, { maxOutputBytes = 65536 } = {}): Model {
  if (typeof ctx.llm?.prepareCall !== 'function') throw new Error('Harness model service unavailable');
  return async (prompt, { signal } = {}) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Model prompt must be nonempty text');
    signal?.throwIfAborted();
    const target = agent.session.requestHeader?.()?.config ?? agent.options;
    if (!target?.provider || !target?.model) throw new Error('The target agent has no configured provider/model');
    // Preserve the session's concrete LlmCallControls; the byte budget is an
    // additional output guard, not permission to reset its token/reasoning budget.
    const config: CallConfig = { provider: target.provider, model: target.model };
    for (const key of ['maxTokens', 'reasoningEffort', 'temperature', 'stop'] as const) {
      if (target[key] !== undefined) Object.assign(config, { [key]: structuredClone(target[key]) });
    }
    const prepared = await ctx.llm.prepareCall(config, signal);
    signal?.throwIfAborted();
    const blocks = new Map<number, { text: string; closed: boolean }>();
    let bytes = 0;
    let finish;
    for await (const chunk of prepared.stream({
      ...prepared.config,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      sessionId: agent.session.id,
      signal,
    })) {
      signal?.throwIfAborted();
      if (chunk.type === 'finish') {
        if (finish) throw new Error('The model emitted duplicate finish events');
        finish = chunk.reason;
        continue;
      }
      if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
        throw new Error('Dream generation must not invoke tools');
      }
      if (chunk.type !== 'text-delta' && !(chunk.type === 'block-end' && chunk.block.type === 'text')) continue;
      if (finish) throw new Error('The model emitted text after finishing');
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0) throw new TypeError('Invalid model block index');
      if (chunk.type === 'text-delta' && typeof chunk.text !== 'string') throw new TypeError('Model output must be text');
      const old = blocks.get(chunk.index) ?? { text: '', closed: false };
      if (old.closed) continue;
      const text = chunk.type === 'text-delta' ? old.text + chunk.text : chunk.block.text;
      if (typeof text !== 'string') throw new TypeError('Model output must be text');
      bytes += Buffer.byteLength(text) - Buffer.byteLength(old.text);
      if (bytes > maxOutputBytes) throw new Error('Model output exceeds the configured byte limit');
      blocks.set(chunk.index, { text, closed: chunk.type === 'block-end' });
    }
    signal?.throwIfAborted();
    if (!finish) throw new Error('The model stream ended without a finish event');
    if (finish.kind !== 'stop') {
      const error: Error & { code?: string } = new Error(`Dream model did not finish successfully: ${finish.kind}`);
      error.code = `MODEL_${String(finish.kind).toUpperCase().replaceAll('-', '_')}`;
      throw error;
    }
    const text = [...blocks.values()].map(block => block.text).join('');
    if (!text.trim()) throw new Error('The model returned no text');
    return text;
  };
}
