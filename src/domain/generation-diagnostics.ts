/** Bounded, content-free execution metadata. Never proposal evidence or write authority. */
export type GenerationStage = 'starting' | 'organize' | 'deep' | 'validation' | 'legacy';
export type GenerationState = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type ModelProgressState = 'preparing' | 'streaming' | 'completed' | 'failed' | 'cancelled';
export interface DiagnosticUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
export interface ModelProgress {
  callId: string; state: ModelProgressState; provider: string; model: string; reasoningEffort?: string;
  inputBytes: number; outputBytes: number; reasoningBytes: number; chunkCount: number;
  preparedAt?: string; firstResponseAt?: string; firstTokenAt?: string; firstTextAt?: string; lastChunkAt?: string;
  usage?: DiagnosticUsage; failureCode?: string; providerRequestId?: string;
}
export interface GenerationCall extends Partial<ModelProgress> {
  sequence: number; stage: GenerationStage; startedAt: string; updatedAt: string; elapsedMs: number;
  state: ModelProgressState; inputBytes: number; outputBytes: number; reasoningBytes: number; chunkCount: number;
  finishedAt?: string;
}
export interface GenerationStageTiming { stage: GenerationStage; startedAt: string; finishedAt?: string; elapsedMs: number }
export interface GenerationDiagnostics {
  schemaVersion: 1; attemptId: string; snapshotId: string; mode: 'memory-v2' | 'legacy';
  state: GenerationState; stage: GenerationStage; startedAt: string; updatedAt: string; elapsedMs: number; timeoutMs: number;
  /** finishedAt is the logical result/cancellation boundary; settledAt proves actual executor drainage. */
  finishedAt?: string; settledAt?: string; failureCode?: string;
  input: { sourceCount: number; contentBytes: number; serializedSourceBytes: number };
  stages: GenerationStageTiming[]; calls: GenerationCall[];
}
const stages: readonly string[] = ['starting', 'organize', 'deep', 'validation', 'legacy'];
const modelStates: readonly string[] = ['preparing', 'streaming', 'completed', 'failed', 'cancelled'];
const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
const timingKeys = ['preparedAt', 'firstResponseAt', 'firstTokenAt', 'firstTextAt', 'lastChunkAt'] as const;
function requireThat(ok: unknown): asserts ok { if (!ok) throw new TypeError('Invalid content-free generation diagnostic'); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every(key => keys.includes(key)));
}
function number(value: unknown) { requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0); }
function name(value: unknown) { requireThat(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n\0]/u.test(value)); }
function time(value: unknown) { requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value))); }
export function diagnosticCode(value: unknown, fallback = 'GENERATION_FAILED'): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(value) ? value : fallback;
}
export function diagnosticUsage(input: unknown): DiagnosticUsage | undefined {
  if (!input || typeof input !== 'object') return;
  const result: DiagnosticUsage = {};
  for (const key of usageKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
/** Strict allow-list at persistence and observer boundaries; no prompts, output text, reasoning or raw errors. */
export function validateModelProgress(input: unknown): ModelProgress {
  object(input, ['callId', 'state', 'provider', 'model', 'reasoningEffort', 'inputBytes', 'outputBytes', 'reasoningBytes', 'chunkCount', ...timingKeys, 'usage', 'failureCode', 'providerRequestId']);
  for (const key of ['callId', 'provider', 'model'] as const) name(input[key]);
  if (input.reasoningEffort !== undefined) name(input.reasoningEffort);
  requireThat(modelStates.includes(String(input.state)));
  for (const key of ['inputBytes', 'outputBytes', 'reasoningBytes', 'chunkCount'] as const) number(input[key]);
  for (const key of timingKeys) if (input[key] !== undefined) time(input[key]);
  if (input.failureCode !== undefined) requireThat(diagnosticCode(input.failureCode, '') === input.failureCode && input.failureCode !== '');
  if (input.providerRequestId !== undefined) name(input.providerRequestId);
  if (input.usage !== undefined) { object(input.usage, usageKeys); Object.values(input.usage).forEach(number); }
  return input as unknown as ModelProgress;
}
export function validateGenerationDiagnostics(input: unknown): GenerationDiagnostics {
  object(input, ['schemaVersion', 'attemptId', 'snapshotId', 'mode', 'state', 'stage', 'startedAt', 'updatedAt', 'elapsedMs', 'timeoutMs', 'finishedAt', 'settledAt', 'failureCode', 'input', 'stages', 'calls']);
  requireThat(input.schemaVersion === 1 && ['memory-v2', 'legacy'].includes(String(input.mode)));
  requireThat(['running', 'completed', 'failed', 'cancelled', 'timed_out'].includes(String(input.state)) && stages.includes(String(input.stage)));
  name(input.attemptId); name(input.snapshotId); time(input.startedAt); time(input.updatedAt); number(input.elapsedMs); number(input.timeoutMs); requireThat(Number(input.timeoutMs) > 0);
  for (const key of ['finishedAt', 'settledAt'] as const) if (input[key] !== undefined) time(input[key]);
  if (input.failureCode !== undefined) requireThat(diagnosticCode(input.failureCode, '') === input.failureCode && input.failureCode !== '');
  object(input.input, ['sourceCount', 'contentBytes', 'serializedSourceBytes']);
  for (const key of ['sourceCount', 'contentBytes', 'serializedSourceBytes']) number(input.input[key]);
  requireThat(Array.isArray(input.stages) && input.stages.length >= 1 && input.stages.length <= 8);
  for (const stage of input.stages) {
    object(stage, ['stage', 'startedAt', 'finishedAt', 'elapsedMs']); requireThat(stages.includes(String(stage.stage)));
    time(stage.startedAt); number(stage.elapsedMs); if (stage.finishedAt !== undefined) time(stage.finishedAt);
  }
  requireThat(Array.isArray(input.calls) && input.calls.length <= 8);
  for (const [index, call] of input.calls.entries()) {
    object(call, ['sequence', 'stage', 'startedAt', 'updatedAt', 'elapsedMs', 'finishedAt', 'callId', 'state', 'provider', 'model', 'reasoningEffort', 'inputBytes', 'outputBytes', 'reasoningBytes', 'chunkCount', ...timingKeys, 'usage', 'failureCode', 'providerRequestId']);
    requireThat(call.sequence === index + 1 && stages.includes(String(call.stage)) && modelStates.includes(String(call.state)));
    time(call.startedAt); time(call.updatedAt); number(call.elapsedMs); if (call.finishedAt !== undefined) time(call.finishedAt);
    const { sequence: _sequence, stage: _stage, startedAt: _start, updatedAt: _update, elapsedMs: _elapsed, finishedAt: _finish, ...progress } = call;
    validateModelProgress({ callId: 'unavailable', provider: 'unavailable', model: 'unavailable', ...progress });
  }
  return input as unknown as GenerationDiagnostics;
}
