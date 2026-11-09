import type { GenerationDiagnostics } from '../src/domain/generation-diagnostics.js';
export interface DreamModelChoice { provider?: string; model?: string; reasoningEffort?: string }
export interface ModelCatalog {
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string } }[] }[];
  failures: { id: string; name: string; message: string }[];
  current?: { provider: string; model: string; reasoningEffort?: string };
}
export interface DreamSettingsStatus {
  state: 'disabled' | 'unconfigured' | 'waiting_session' | 'ready' | 'running' | 'unavailable';
  reason?: string;
  model?: { provider: string; model: string; reasoningEffort?: string };
  executor?: 'native' | 'ptc' | 'unknown';
  jobs?: Array<{ jobId: string; state: string; proposals: number; applied: number; error?: { code: string; message: string }; generationDiagnostics?: GenerationDiagnostics }>;
}
export interface DreamSettingsSnapshot {
  revision: string;
  writable: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
  inherited: Record<string, unknown>;
  configured: boolean;
  hostTimeZone: string;
  status: DreamSettingsStatus;
  issues: Array<{ field?: string; message: string }>;
  sessionOptions: SessionOption[];
}
export interface SessionOption { id: string; title: string; cwd?: string; live: boolean }
export interface MessageOption { sessionId: string; seq: number; role: string; text: string; blocks: Array<{ blockIndex: number; text: string }> }
export interface Readiness { checks: Array<{ id: string; state: 'ready' | 'unavailable' | 'invalid'; message: string }>; canEnable: boolean }
export interface OriginalBinding { sourceId: string; ref: { sessionId: string; seq: number; blockIndex: number; quote: string } }
export interface DreamContextRef { sessionId: string; seq: number }
export interface DreamSettingsApi {
  read(signal?: AbortSignal): Promise<DreamSettingsSnapshot>;
  save(input: { revision: string; config: Record<string, unknown>; enabled: boolean; confirmEnable?: true; confirmScope?: true }): Promise<DreamSettingsSnapshot>;
  preflight(input: { config: Record<string, unknown> }, signal?: AbortSignal): Promise<Readiness>;
  sessions(input: { query?: string }, signal?: AbortSignal): Promise<{ items: SessionOption[]; truncated: boolean }>;
  models(input: { sessionId?: string }, signal?: AbortSignal): Promise<ModelCatalog>;
  pickDirectory(signal?: AbortSignal): Promise<string | null>;
  pickFile(signal?: AbortSignal): Promise<string | null>;
  messages(input: { sessionId: string; query?: string; cursor?: string }, signal?: AbortSignal): Promise<{ items: MessageOption[]; cursor?: string; truncated: boolean }>;
  status(signal?: AbortSignal): Promise<DreamSettingsStatus>;
}
export interface DreamLocale {
  bind(namespace: string): (key: string) => string;
  getSnapshot(): { active: string; revision: number };
  subscribe(listener: () => void): () => void;
}
export interface SettingsPageProps { close(): void }

/** User-only owner-checked Host routes. A transport failure never means a write
 * failed before commit: callers keep the draft and refresh before retrying. */
export function createDreamSettingsApi(baseURI: string = document.baseURI): DreamSettingsApi {
  async function call<T>(method: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(new URL(`api/dsh-dream/${method}`, baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
    });
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('ok' in result)) throw Object.assign(new Error(`Invalid settings response (${response.status})`), { code: 'INVALID_RESPONSE' });
    const envelope = result as { ok: boolean; value?: T; error?: { code?: string; message?: string; details?: unknown } };
    if (!response.ok || !envelope.ok) throw Object.assign(new Error(envelope.error?.message ?? `Settings request failed (${response.status})`), {
      code: envelope.error?.code ?? 'REQUEST_FAILED', details: envelope.error?.details,
    });
    return envelope.value as T;
  }
  return { read: signal => call('read', {}, signal), save: input => call('save', input), preflight: (input, signal) => call('preflight', input, signal),
    models: (input, signal) => call('models', input, signal), sessions: (input, signal) => call('sessions', input, signal), pickDirectory: signal => call('pick-directory', {}, signal), pickFile: signal => call('pick-file', {}, signal), messages: (input, signal) => call('messages', input, signal), status: signal => call('status', {}, signal) };
}
