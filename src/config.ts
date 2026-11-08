import { isAbsolute, resolve } from 'node:path';

/** Validate explicit installation settings; no profile or model credentials are read. */
import type { DreamConfig } from './types.js';
import { errorFields } from './types.js';

const MAX_TIMEOUT_MS = 2147483647;
export const CONFIG_FIELDS: readonly string[] = ['sessionId', 'memoryRoot', 'stateRoot', 'personaPath', 'start', 'end', 'timeZone',
  'maxSourceBytes', 'maxInputBytes', 'maxOutputBytes', 'maxProposals', 'maxChangeBytes', 'maxPromotions', 'maxCandidates', 'sourceSessionIds', 'originalSources', 'maxOriginalBytes', 'reinforcementBoost', 'recallHistoryDays', 'maxRecallFiles', 'maxRecallBytes', 'maxEpisodes', 'dreamMode', 'dreamTimeoutMs', 'maxDreamContextBytes', 'dreamContextRefs', 'dreamMood', 'timeoutMs', 'compactionMode', 'singleRun'];
/** Detached public defaults. Required identity/paths remain unset until the user chooses them. */
export function configurationDefaults(): Omit<DreamConfig, 'sessionId' | 'memoryRoot' | 'stateRoot'> {
  return { start: '05:00', end: '07:00', timeZone: 'local',
    maxSourceBytes: 131072, maxInputBytes: 524288, maxOutputBytes: 65536,
    sourceSessionIds: [], originalSources: [], maxOriginalBytes: 65536, reinforcementBoost: 0.25,
    recallHistoryDays: 90, maxRecallFiles: 128, maxRecallBytes: 1048576,
    maxEpisodes: 32, dreamMode: 'separate', dreamTimeoutMs: 180000, maxDreamContextBytes: 16384, dreamContextRefs: [],
    maxProposals: 32, maxChangeBytes: 32768, maxPromotions: 4, maxCandidates: 64, timeoutMs: 900000, compactionMode: 'auto', singleRun: false };
}

export function validateConfig(value: unknown): DreamConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Configuration must be an object');
  for (const key of Object.keys(value)) if (!CONFIG_FIELDS.includes(key)) throw new TypeError(`Unknown configuration field: ${key}`);
  const config = { ...configurationDefaults(), ...value } as unknown as DreamConfig; // Untrusted candidate view: every field is checked below before use.
  for (const key of ['sessionId', 'memoryRoot', 'stateRoot'] as const) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new TypeError(`${key} is required`);
  }
  for (const key of ['memoryRoot', 'stateRoot', 'personaPath'] as const) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !isAbsolute(config[key]))) throw new TypeError(`${key} must be an absolute path`);
  }
  if (resolve(config.memoryRoot) === resolve(config.stateRoot)) throw new TypeError('stateRoot must be separate from memoryRoot');
  for (const key of ['start', 'end'] as const) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config[key])) throw new TypeError(`${key} must be HH:mm`);
  }
  if (config.start === config.end) throw new TypeError('The rest window must have a nonzero length');
  if (config.timeZone !== 'local') new Intl.DateTimeFormat('en', { timeZone: config.timeZone });
  for (const key of ['maxSourceBytes', 'maxInputBytes', 'maxOutputBytes', 'maxProposals', 'maxChangeBytes', 'maxPromotions', 'maxCandidates', 'maxOriginalBytes'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new TypeError(`${key} must be a positive integer`);
  }
  for (const key of ['timeoutMs', 'dreamTimeoutMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > MAX_TIMEOUT_MS) throw new TypeError(`${key} must be a positive integer at most ${MAX_TIMEOUT_MS} milliseconds`);
  }
  if (!Array.isArray(config.sourceSessionIds) || config.sourceSessionIds.length > 16 || new Set(config.sourceSessionIds).size !== config.sourceSessionIds.length || config.sourceSessionIds.some(s => typeof s !== 'string' || !s.trim())) throw new TypeError('sourceSessionIds must be an explicit unique session allowlist');
  if (!Array.isArray(config.originalSources) || config.originalSources.length > 64) throw new TypeError('originalSources must contain at most 64 bindings');
  for (const binding of config.originalSources) {
    if (!binding || typeof binding !== 'object' || Object.keys(binding).some(k => !['sourceId', 'ref'].includes(k)) || typeof binding.sourceId !== 'string' || !binding.sourceId.trim()) throw new TypeError('Invalid original source binding');
    const ref = binding.ref;
    if (!ref || typeof ref !== 'object' || Object.keys(ref).some(k => !['sessionId', 'seq', 'blockIndex', 'quote'].includes(k)) || typeof ref.sessionId !== 'string' || ![config.sessionId, ...config.sourceSessionIds].includes(ref.sessionId) || !Number.isSafeInteger(ref.seq) || ref.seq < 0 || !Number.isSafeInteger(ref.blockIndex) || ref.blockIndex < 0 || typeof ref.quote !== 'string' || !ref.quote.trim() || Buffer.byteLength(ref.quote) > config.maxOriginalBytes) throw new TypeError('Original references require an authorized session, exact seq/block and bounded quote');
  }
  if (typeof config.reinforcementBoost !== 'number' || !Number.isFinite(config.reinforcementBoost) || config.reinforcementBoost < 0 || config.reinforcementBoost > 1) throw new TypeError('reinforcementBoost must be between 0 and 1');
  if (!['auto', 'manual', 'agent'].includes(config.compactionMode)) throw new TypeError('compactionMode must be auto, manual or agent');
  if (typeof config.singleRun !== 'boolean') throw new TypeError('singleRun must be a boolean');
  if (!Number.isSafeInteger(config.recallHistoryDays) || config.recallHistoryDays < 0 || config.recallHistoryDays > 3650) throw new TypeError('recallHistoryDays must be 0–3650; 0 disables historical daily recall');
  if (!Number.isSafeInteger(config.maxRecallFiles) || config.maxRecallFiles < 1 || config.maxRecallFiles > 1024) throw new TypeError('maxRecallFiles must be 1–1024');
  if (!Number.isSafeInteger(config.maxRecallBytes) || config.maxRecallBytes < 512 || config.maxRecallBytes > 8388608) throw new TypeError('maxRecallBytes must be 512–8388608');
  if (!Number.isSafeInteger(config.maxEpisodes) || config.maxEpisodes < 1 || config.maxEpisodes > 128) throw new TypeError('maxEpisodes must be 1–128');
  if (!['off', 'separate'].includes(config.dreamMode)) throw new TypeError('dreamMode must be off or separate');
  if (!Number.isSafeInteger(config.maxDreamContextBytes) || config.maxDreamContextBytes < 512 || config.maxDreamContextBytes > 65536) throw new TypeError('maxDreamContextBytes must be 512–65536');
  if (!Array.isArray(config.dreamContextRefs) || config.dreamContextRefs.length > 16 || new Set(config.dreamContextRefs.map(r => JSON.stringify(r))).size !== config.dreamContextRefs.length) throw new TypeError('dreamContextRefs must contain at most 16 unique positions');
  for (const ref of config.dreamContextRefs) {
    if (!ref || typeof ref !== 'object' || Object.keys(ref).some(k => !['sessionId', 'seq'].includes(k)) || ![config.sessionId, ...config.sourceSessionIds].includes(ref.sessionId) || !Number.isSafeInteger(ref.seq) || ref.seq < 0) throw new TypeError('Dream context positions require an authorized session and exact seq');
  }
  if (config.dreamMood !== undefined) {
    const mood = config.dreamMood;
    if (!mood || typeof mood !== 'object' || Object.keys(mood).some(k => !['text', 'at'].includes(k)) || typeof mood.text !== 'string' || !mood.text.trim() || Buffer.byteLength(mood.text) > 2048 || typeof mood.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(mood.at) || !Number.isFinite(Date.parse(mood.at))) throw new TypeError('dreamMood requires bounded text and a timestamp; it is background, not an instruction');
  }
  if (config.maxSourceBytes > config.maxInputBytes) throw new TypeError('maxSourceBytes exceeds maxInputBytes');
  return config;
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-dream',
    validate(value: unknown) {
      try { return { value: validateConfig(value) }; }
      catch (error) { return { issues: [{ message: errorFields(error).message }] }; }
    },
  },
};
