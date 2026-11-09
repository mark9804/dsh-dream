import { createHash } from 'node:crypto';
import type { Scope } from '../types.js';
import type { GenerationStage } from './generation-diagnostics.js';
import type { QuoteValidationIssue } from './quote-diagnostics.js';
import { validateQuoteValidationIssue } from './quote-diagnostics.js';

/** Private troubleshooting artifact. Never proposal evidence or write authority. */
export interface GenerationAttempt {
  schemaVersion: 1; attemptId: string; jobId: string; snapshotId: string; scope: Scope;
  mode: 'memory-v2' | 'legacy'; startedAt: string; failedAt: string; stage: GenerationStage;
  outputs: { sequence: number; stage: GenerationStage; text: string; bytes: number; retainedBytes: number; truncated: boolean; sha256: string }[];
  validation: { code: 'GENERATION_VALIDATION_FAILED'; message: string; issue?: QuoteValidationIssue };
  private: true; untrusted: true;
}
import type { GenerationAttemptDetails } from './validation-debug.js';
export type { GenerationAttemptDetails } from './validation-debug.js';
export const MAX_ATTEMPT_RETAINED_BYTES = 2 * 1024 * 1024;
export const MAX_GENERATION_ATTEMPT_BYTES = 16 * 1024 * 1024;
const stages: readonly string[] = ['starting', 'organize', 'deep', 'validation', 'legacy'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function requireThat(ok: unknown): asserts ok { if (!ok) throw new TypeError('Invalid private generation attempt'); }
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every(key => keys.includes(key)));
}
function name(value: unknown, limit = 512): asserts value is string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\r\n\0]/u.test(value));
}
function timestamp(value: unknown): asserts value is string {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value)));
}
export function validateGenerationAttempt(value: unknown): GenerationAttempt {
  object(value, ['schemaVersion', 'attemptId', 'jobId', 'snapshotId', 'scope', 'mode', 'startedAt', 'failedAt', 'stage', 'outputs', 'validation', 'private', 'untrusted']);
  requireThat(value.schemaVersion === 1 && value.private === true && value.untrusted === true);
  name(value.attemptId); requireThat(uuid.test(value.attemptId)); name(value.jobId); name(value.snapshotId);
  object(value.scope, ['scopeId', 'agentId', 'sessionId', 'memoryRootId']);
  for (const key of ['scopeId', 'agentId', 'sessionId', 'memoryRootId']) name(value.scope[key], 4096);
  requireThat(value.mode === 'memory-v2' || value.mode === 'legacy');
  timestamp(value.startedAt); timestamp(value.failedAt); requireThat(Date.parse(value.failedAt) >= Date.parse(value.startedAt));
  requireThat(stages.includes(String(value.stage)));
  requireThat(Array.isArray(value.outputs) && value.outputs.length <= 8);
  const counts = new Map<string, number>(); let previous = 0; let retained = 0;
  for (const output of value.outputs) {
    object(output, ['sequence', 'stage', 'text', 'bytes', 'retainedBytes', 'truncated', 'sha256']);
    requireThat(typeof output.sequence === 'number' && Number.isSafeInteger(output.sequence) && output.sequence > previous);
    previous = output.sequence;
    requireThat(stages.includes(String(output.stage)) && typeof output.text === 'string');
    requireThat(typeof output.bytes === 'number' && Number.isSafeInteger(output.bytes) && output.bytes >= 0);
    requireThat(typeof output.retainedBytes === 'number' && Number.isSafeInteger(output.retainedBytes) && output.retainedBytes >= 0 && output.retainedBytes === Buffer.byteLength(output.text as string));
    requireThat(typeof output.truncated === 'boolean' && typeof output.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(output.sha256));
    requireThat(output.truncated ? output.bytes > output.retainedBytes : output.bytes === output.retainedBytes);
    if (!output.truncated) requireThat(output.sha256 === createHash('sha256').update(output.text as string).digest('hex'));
    retained += output.retainedBytes; requireThat(retained <= MAX_ATTEMPT_RETAINED_BYTES);
    const count = (counts.get(String(output.stage)) ?? 0) + 1; requireThat(count <= 4); counts.set(String(output.stage), count);
  }
  object(value.validation, ['code', 'message', 'issue']); requireThat(value.validation.code === 'GENERATION_VALIDATION_FAILED');
  requireThat(typeof value.validation.message === 'string' && value.validation.message.trim().length > 0 && value.validation.message.length <= 32768);
  if (value.validation.issue !== undefined) validateQuoteValidationIssue(value.validation.issue);
  requireThat(Buffer.byteLength(JSON.stringify(value)) + 1 <= MAX_GENERATION_ATTEMPT_BYTES);
  return value as unknown as GenerationAttempt;
}
export function validateGenerationAttemptDetails(value: unknown): GenerationAttemptDetails {
  object(value, ['attemptId', 'attemptPath', 'stage', 'validationIssue', 'archiveState', 'archiveErrorCode']);
  name(value.attemptId); requireThat(uuid.test(value.attemptId)); requireThat(stages.includes(String(value.stage)));
  requireThat(value.archiveState === 'saved' || value.archiveState === 'failed');
  if (value.archiveState === 'saved') { name(value.attemptPath, 4096); requireThat(value.archiveErrorCode === undefined); }
  else { requireThat(value.attemptPath === undefined); name(value.archiveErrorCode, 128); requireThat(/^[A-Za-z0-9_.:/-]+$/u.test(value.archiveErrorCode)); }
  if (value.validationIssue !== undefined) validateQuoteValidationIssue(value.validationIssue);
  return value as unknown as GenerationAttemptDetails;
}
