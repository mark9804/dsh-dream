import { randomUUID } from 'node:crypto';
import type { HostContext, Agent } from './types.js';
import type { DreamModelChoice, Model, ModelOptions } from '../types.js';
import { validateDreamModelChoice } from '../config.js';
import { errorFields } from '../types.js';
import { diagnosticCode, diagnosticUsage, validateModelProgress } from '../domain/generation-diagnostics.js';
import type { ModelProgress } from '../domain/generation-diagnostics.js';
import { captureModelChoice, copyCallConfig } from './model-selection.js';
import type { SelectedCallConfig } from './model-selection.js';

interface OutputBlock { kind: 'text' | 'reasoning'; text: string; closed: boolean; hasDelta: boolean; byteCount?: number }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One fresh, history-free call using the target's model route and controls.
 * capture() fixes a background worker admission across all its stage calls. */
export function createHostModel(ctx: HostContext, agent: Agent, { maxOutputBytes = 65536, modelChoice }: { maxOutputBytes?: number; modelChoice?: DreamModelChoice } = {}): Model & { capture(): Model } {
  if (typeof ctx.llm?.prepareCall !== 'function') throw new Error('Harness model service unavailable');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new RangeError('Invalid model maxOutputBytes');
  const choice = validateDreamModelChoice(modelChoice);
  const invoke = async (prompt: string, { signal, onProgress }: ModelOptions = {}, captured?: SelectedCallConfig): Promise<string> => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Model prompt must be nonempty text');
    signal?.throwIfAborted();
    // Copy only concrete LlmCallControls, not native session/system/tool state.
    // The byte budget is an additional guard, not a replacement token budget.
    const config = captured ? copyCallConfig(captured) : captureModelChoice(agent, choice);
    const stamp = () => new Date().toISOString();
    const progress: ModelProgress = { callId: randomUUID(), state: 'preparing', provider: config.provider, model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}), inputBytes: Buffer.byteLength(prompt), outputBytes: 0, reasoningBytes: 0, chunkCount: 0 };
    let lastProgress = 0;
    async function publish(force = true) {
      if (!onProgress || !force && performance.now() - lastProgress < 5000) return;
      lastProgress = performance.now();
      await onProgress(structuredClone(validateModelProgress(progress)));
      signal?.throwIfAborted();
    }
    try {
    if (onProgress) await publish();
    signal?.throwIfAborted();
    const prepared = await ctx.llm.prepareCall(config, signal);
    signal?.throwIfAborted();
    const actual = copyCallConfig(prepared.config);
    progress.provider = actual.provider; progress.model = actual.model;
    if (actual.reasoningEffort) progress.reasoningEffort = actual.reasoningEffort; else delete progress.reasoningEffort;
    progress.state = 'streaming'; progress.preparedAt = stamp(); await publish(); signal?.throwIfAborted();
    const blocks = new Map<number, OutputBlock>();
    let bytes = 0;
    let finish: { kind: string } | undefined;
    // Keep for-await's awaited iterator cleanup: generation cancellation must
    // drain the underlying call before the worker and its lock can be released.
    for await (const value of prepared.stream({
      ...actual,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      sessionId: progress.callId,
      signal,
    })) {
      signal?.throwIfAborted();
      const chunk: unknown = value;
      if (!record(chunk)) throw new TypeError('Invalid model stream chunk');
      progress.chunkCount++; progress.lastChunkAt = stamp(); progress.firstResponseAt ??= progress.lastChunkAt;
      if (chunk.type === 'finish') {
        if (finish) throw new Error('The model emitted duplicate finish events');
        if (!record(chunk.reason) || typeof chunk.reason.kind !== 'string') throw new TypeError('Invalid model finish event');
        finish = { kind: chunk.reason.kind };
        if (record(chunk.reason.failure)) {
          progress.failureCode = diagnosticCode(chunk.reason.failure.code, 'MODEL_ERROR');
          const requestId = chunk.reason.failure.requestId;
          if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 512 && !/[\r\n\0]/u.test(requestId)) progress.providerRequestId = requestId;
        }
        await publish();
        continue;
      }
      if (chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && typeof chunk.blockType === 'string' && chunk.blockType.startsWith('tool-'))
        || (chunk.type === 'block-end' && record(chunk.block) && typeof chunk.block.type === 'string' && chunk.block.type.startsWith('tool-'))) {
        throw new Error('Dream generation must not invoke tools');
      }
      if (chunk.type === 'usage') { const usage = diagnosticUsage(chunk.usage); if (usage) progress.usage = usage; await publish(); continue; }
      if (finish) throw new Error('The model emitted content after finishing');
      if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta' && chunk.type !== 'block-start' && chunk.type !== 'block-end') {
        throw new TypeError('Unsupported model stream chunk');
      }
      if (typeof chunk.index !== 'number' || !Number.isSafeInteger(chunk.index) || chunk.index < 0) throw new TypeError('Invalid model block index');
      const kind = chunk.type === 'block-start' ? chunk.blockType
        : chunk.type === 'block-end' ? (record(chunk.block) ? chunk.block.type : undefined)
          : chunk.type === 'text-delta' ? 'text' : 'reasoning';
      if (kind !== 'text' && kind !== 'reasoning') throw new TypeError('Model output must be text');
      const previous = blocks.get(chunk.index);
      if (previous && (previous.closed || previous.kind !== kind || chunk.type === 'block-start')) throw new Error('Invalid model block sequence');
      if (!previous && blocks.size >= 1024) throw new Error('The model emitted too many blocks');
      const block: OutputBlock = previous ?? { kind, text: '', closed: false, hasDelta: false };
      if (chunk.type !== 'block-start') {
        const part = chunk.type === 'block-end' && record(chunk.block) ? chunk.block.text : chunk.text;
        if (typeof part !== 'string') throw new TypeError('Model output must be text');
        const firstToken = part.length > 0 && !progress.firstTokenAt, firstText = kind === 'text' && part.length > 0 && !progress.firstTextAt;
        if (part.length) { progress.firstTokenAt ??= progress.lastChunkAt; if (kind === 'text') progress.firstTextAt ??= progress.lastChunkAt; }
        if (kind === 'reasoning') {
          const size = Buffer.byteLength(part);
          const nextSize = chunk.type === 'block-end' ? size : (block.byteCount ?? 0) + size;
          progress.reasoningBytes += nextSize - (block.byteCount ?? 0);
          // Retain only a byte count for reasoning, never its text.
          block.byteCount = nextSize;
        }
        if (kind === 'text') {
          if (chunk.type === 'block-end' && block.hasDelta && part !== block.text) throw new Error('Model final text disagrees with streamed text');
          const text = chunk.type === 'block-end' ? part : block.text + part;
          bytes += Buffer.byteLength(text) - Buffer.byteLength(block.text);
          if (bytes > maxOutputBytes) throw new Error('Model output exceeds the configured byte limit');
          block.text = text;
        }
        block.closed = chunk.type === 'block-end';
        block.hasDelta ||= chunk.type !== 'block-end';
        progress.outputBytes = bytes;
        await publish(firstToken || firstText);
      }
      blocks.set(chunk.index, block);
    }
    signal?.throwIfAborted();
    if (!finish) throw new Error('The model stream ended without a finish event');
    if (finish.kind !== 'stop') {
      const error: Error & { code?: string } = new Error(`Dream model did not finish successfully: ${finish.kind}`);
      error.code = progress.failureCode ?? `MODEL_${String(finish.kind).toUpperCase().replaceAll('-', '_')}`;
      throw error;
    }
    const text = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block.kind === 'text' ? block.text : '').join('');
    if (!text.trim()) throw new Error('The model returned no text');
    progress.state = 'completed'; await publish();
    return text;
    } catch (error) {
      progress.state = signal?.aborted ? 'cancelled' : 'failed';
      progress.failureCode ??= diagnosticCode(errorFields(error).code, signal?.aborted ? 'MODEL_CANCELLED' : 'MODEL_FAILED');
      try { await publish(); } catch { /* Preserve the original model/observer failure. */ }
      throw error;
    }
  };
  return Object.assign((prompt: string, options?: ModelOptions) => invoke(prompt, options), {
    capture(): Model {
      const config = captureModelChoice(agent, choice);
      return (prompt, options) => invoke(prompt, options, config);
    },
  });
}
