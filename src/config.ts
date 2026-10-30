import { isAbsolute, resolve } from 'node:path';

/** Validate explicit installation settings; no profile or model credentials are read. */
import type { DreamConfig } from './types.js';
import { errorFields } from './types.js';

export function validateConfig(value: unknown): DreamConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Configuration must be an object');
  const allowed = ['sessionId', 'memoryRoot', 'stateRoot', 'personaPath', 'start', 'end', 'timeZone',
    'maxSourceBytes', 'maxInputBytes', 'maxOutputBytes', 'maxProposals', 'timeoutMs', 'compactionMode', 'singleRun'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Unknown configuration field: ${key}`);
  const config = {
    start: '05:00', end: '07:00', timeZone: 'local',
    maxSourceBytes: 131072, maxInputBytes: 524288, maxOutputBytes: 65536,
    maxProposals: 32, timeoutMs: 300000, compactionMode: 'auto', singleRun: false,
    ...value,
  } as DreamConfig; // Candidate view: each configurable field is checked below.
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
  for (const key of ['maxSourceBytes', 'maxInputBytes', 'maxOutputBytes', 'maxProposals', 'timeoutMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new TypeError(`${key} must be a positive integer`);
  }
  if (!['auto', 'manual', 'agent'].includes(config.compactionMode)) throw new TypeError('compactionMode must be auto, manual or agent');
  if (typeof config.singleRun !== 'boolean') throw new TypeError('singleRun must be a boolean');
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
