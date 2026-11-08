import type { DreamContextRef, OriginalBinding } from './api.js';
import type { LocaleKey } from './locale.js';

const millisecondsPerMinute = 60000;
export const maximumTimeoutMs = 2147483647;
const timeoutField = { min: 1, max: maximumTimeoutMs, unit: '', duration: true } as const;
export interface TimeoutParts { minutes: string; seconds: string }
export function timeoutParts(milliseconds: unknown): TimeoutParts {
  if (typeof milliseconds !== 'number' || !Number.isSafeInteger(milliseconds) || milliseconds < 0) return { minutes: String(milliseconds ?? ''), seconds: '0' };
  return { minutes: String(Math.floor(milliseconds / millisecondsPerMinute)), seconds: String((milliseconds % millisecondsPerMinute) / 1000) };
}
export function isTimeoutParts(value: unknown): value is TimeoutParts {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'minutes' || key === 'seconds')
    && typeof (value as TimeoutParts).minutes === 'string' && typeof (value as TimeoutParts).seconds === 'string';
}
export const numericFields = {
  dreamTimeoutMs: timeoutField,
  maxDreamContextBytes: { min: 512, max: 65536, unit: 'bytes' },
  recallHistoryDays: { min: 0, max: 3650, unit: 'days' },
  maxRecallFiles: { min: 1, max: 1024, unit: 'count' },
  maxRecallBytes: { min: 512, max: 8388608, unit: 'bytes' },
  reinforcementBoost: { min: 0, max: 1, unit: '', fractional: true },
  maxSourceBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'bytes' },
  maxInputBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'bytes' },
  maxOutputBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'bytes' },
  maxProposals: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'count' },
  maxChangeBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'bytes' },
  maxPromotions: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'count' },
  maxCandidates: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'count' },
  maxEpisodes: { min: 1, max: 128, unit: 'count' },
  timeoutMs: timeoutField,
  maxOriginalBytes: { min: 1, max: Number.MAX_SAFE_INTEGER, unit: 'bytes' },
} as const;
export type NumericField = keyof typeof numericFields;
export type ConfigField = NumericField | 'sessionId' | 'memoryRoot' | 'stateRoot' | 'personaPath' | 'start' | 'end' | 'timeZone'
  | 'compactionMode' | 'singleRun' | 'dreamMode' | 'dreamMood' | 'sourceSessionIds' | 'originalSources' | 'dreamContextRefs';
export type Draft = Record<string, unknown>;
export type FieldErrors = Partial<Record<ConfigField, LocaleKey>>;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const string = (value: unknown) => typeof value === 'string' ? value : '';
const absolute = (value: string) => value.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value);
export function draftOf(config: Record<string, unknown>): Draft {
  const draft = structuredClone(config);
  for (const field of Object.keys(numericFields) as NumericField[]) if (draft[field] !== undefined) {
    const value = draft[field];
    // Persisted/API values remain milliseconds; duration drafts are a minute/second pair.
    draft[field] = 'duration' in numericFields[field] ? timeoutParts(value) : String(value);
  }
  return draft;
}
export function serializeDraft(draft: Draft, { enabled = true }: { enabled?: boolean } = {}): { config: Record<string, unknown>; errors: FieldErrors } {
  const config = structuredClone(draft);
  const errors: FieldErrors = {};
  for (const field of Object.keys(numericFields) as NumericField[]) {
    const rule = numericFields[field];
    if ('duration' in rule) {
      const parts = draft[field];
      if (!isTimeoutParts(parts)) { errors[field] = 'fieldNumber'; continue; }
      const minutes = parts.minutes.trim() ? Number(parts.minutes) : NaN;
      // Clearing seconds means its documented default, zero; minutes remain required.
      const seconds = parts.seconds.trim() ? Number(parts.seconds) : 0;
      const secondMs = Math.round(seconds * 1000), milliseconds = minutes * millisecondsPerMinute + secondMs;
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) errors[field] = 'fieldNumber';
      else if (!Number.isSafeInteger(minutes)) errors[field] = 'fieldInteger';
      else if (minutes < 0 || seconds < 0 || seconds >= 60 || milliseconds < rule.min || milliseconds > rule.max) errors[field] = 'fieldTimeoutRange';
      else if (!Number.isSafeInteger(secondMs) || secondMs / 1000 !== seconds) errors[field] = 'fieldTimeoutPrecision';
      config[field] = milliseconds;
      continue;
    }
    const raw = typeof draft[field] === 'number' ? String(draft[field]) : string(draft[field]);
    const value = raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(value)) errors[field] = 'fieldNumber';
    else if (!('fractional' in rule) && !Number.isSafeInteger(value)) errors[field] = 'fieldInteger';
    else if (value < rule.min || value > rule.max) errors[field] = 'fieldRange';
    config[field] = value;
  }
  for (const field of ['sessionId', 'memoryRoot', 'stateRoot'] as const) {
    if (!string(draft[field]).trim()) {
      if (enabled) errors[field] = 'fieldRequired';
      else delete config[field];
    }
  }
  if (!string(draft.timeZone).trim()) errors.timeZone = 'fieldRequired';
  for (const field of ['memoryRoot', 'stateRoot', 'personaPath'] as const) {
    const value = string(draft[field]);
    if (field === 'personaPath' && !value.trim()) delete config.personaPath;
    else if (value.trim() && !absolute(value)) errors[field] = 'fieldAbsolute';
  }
  if (string(draft.memoryRoot).trim() && draft.memoryRoot === draft.stateRoot) errors.stateRoot = 'fieldAbsolute';
  for (const field of ['start', 'end'] as const) if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(string(draft[field]))) errors[field] = 'fieldTime';
  if (draft.start === draft.end) errors.end = 'fieldTime';
  if (draft.timeZone !== 'local') {
    try { new Intl.DateTimeFormat('en', { timeZone: string(draft.timeZone) }).format(); } catch { errors.timeZone = 'fieldTimeZone'; }
  }
  if (Number(config.maxSourceBytes) > Number(config.maxInputBytes)) errors.maxSourceBytes = 'fieldSourceBudget';
  if (!['auto', 'manual', 'agent'].includes(string(draft.compactionMode))) errors.compactionMode = 'fieldRange';
  if (!['off', 'separate'].includes(string(draft.dreamMode))) errors.dreamMode = 'fieldRange';
  if (typeof draft.singleRun !== 'boolean') errors.singleRun = 'fieldRange';
  const sessions = Array.isArray(draft.sourceSessionIds) ? draft.sourceSessionIds : [];
  if (sessions.length > 16 || sessions.some(id => typeof id !== 'string' || !id.trim()) || new Set(sessions).size !== sessions.length) errors.sourceSessionIds = 'fieldTooManySources';
  config.sourceSessionIds = [...sessions];
  const authorized = new Set([draft.sessionId, ...sessions]);
  const originals = (Array.isArray(draft.originalSources) ? draft.originalSources : []) as OriginalBinding[];
  const refs = (Array.isArray(draft.dreamContextRefs) ? draft.dreamContextRefs : []) as DreamContextRef[];
  if (originals.length > 64 || originals.some(item => !item.sourceId?.trim() || !authorized.has(item.ref?.sessionId)
    || !Number.isSafeInteger(item.ref.seq) || item.ref.seq < 0 || !Number.isSafeInteger(item.ref.blockIndex) || item.ref.blockIndex < 0
    || !item.ref.quote?.trim() || bytes(item.ref.quote) > Number(config.maxOriginalBytes))) errors.originalSources = 'fieldRefs';
  if (refs.length > 16 || new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length || refs.some(ref => !authorized.has(ref.sessionId) || !Number.isSafeInteger(ref.seq) || ref.seq < 0)) errors.dreamContextRefs = 'fieldRefs';
  config.originalSources = structuredClone(originals); config.dreamContextRefs = structuredClone(refs);
  if (draft.dreamMood !== undefined) {
    const mood = draft.dreamMood as { text?: string; at?: string };
    if (!mood.text?.trim() || bytes(mood.text) > 2048 || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(mood.at ?? '') || !Number.isFinite(Date.parse(mood.at ?? ''))) errors.dreamMood = 'fieldMood';
  }
  return { config, errors };
}
export function scopeChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return ['sessionId', 'memoryRoot', 'stateRoot', 'personaPath', 'sourceSessionIds', 'originalSources', 'dreamContextRefs'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
export function errorMessage(error: unknown, fallback: string): { code: string; message: string } {
  if (error !== null && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown };
    return { code: typeof value.code === 'string' ? value.code : '', message: typeof value.message === 'string' ? value.message : fallback };
  }
  return { code: '', message: fallback };
}
export function stringValue(value: unknown): string { return string(value); }
