import { CONFIG_FIELDS, configurationDefaults, validateConfig } from '../config.js';
import type { DreamConfig } from '../types.js';
import { errorFields } from '../types.js';

export interface SettingsConfiguration { enabled: boolean; configuration: Partial<DreamConfig> }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** A complete form may be saved before required paths/session are chosen. The
 * business starts ONLY from a fully valid explicit enabled configuration. */
export function validateSettingsConfiguration(value: unknown): SettingsConfiguration {
  if (!record(value) || Object.keys(value).some(key => key !== 'enabled' && key !== 'configuration')) throw new TypeError('Invalid Dream settings document');
  const enabled = value.enabled ?? false, configuration = value.configuration ?? {};
  if (typeof enabled !== 'boolean' || !record(configuration)) throw new TypeError('Dream settings require enabled and a configuration object');
  for (const key of Object.keys(configuration)) if (!CONFIG_FIELDS.includes(key)) throw new TypeError(`Unknown configuration field: ${key}`);
  const detached = structuredClone(configuration);
  for (const key of ['personaPath', 'dreamMood'] as const) if (detached[key] === undefined) delete detached[key];
  const candidate = { ...detached };
  const missing = ['sessionId', 'memoryRoot', 'stateRoot'].filter(key => candidate[key] === undefined || candidate[key] === '');
  if (enabled) validateConfig(candidate);
  else {
    // Validate every supplied optional field without inventing an authorization.
    // Sentinels exist only in this local check and are never persisted/bound/read.
    for (const key of missing) delete detached[key];
    const placeholders = { sessionId: '__unconfigured__', memoryRoot: '/__dsh_dream_unconfigured_memory__', stateRoot: '/__dsh_dream_unconfigured_state__' };
    validateConfig({ ...placeholders, ...detached });
  }
  return { enabled, configuration: detached as Partial<DreamConfig> };
}
export function resolvedDraft(config: Partial<DreamConfig>): Partial<DreamConfig> { return { ...configurationDefaults(), ...structuredClone(config) }; }
export function configurationIssues(config: unknown): { field?: string; message: string }[] {
  try { validateConfig(config); return []; }
  catch (error) { const message = errorFields(error).message ?? String(error); return [{ field: CONFIG_FIELDS.find(key => message.includes(key)), message }]; }
}
export const Config = { '~standard': { version: 1, vendor: 'dsh-dream-settings', validate(value: unknown) {
  try { return { value: validateSettingsConfiguration(value) }; }
  catch (error) { return { issues: [{ message: errorFields(error).message }] }; }
} } };
