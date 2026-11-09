import type { DreamConfig, ErrorInfo } from '../types.js';
import type { SessionDirectoryItem } from './sessions.js';
import type { GenerationDiagnostics } from '../domain/generation-diagnostics.js';
export interface ModelCatalog {
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string } }[] }[];
  failures: { id: string; name: string; message: string }[];
  current?: { provider: string; model: string; reasoningEffort?: string };
}
export interface SettingsIssue { field?: string; message: string }
export interface RuntimeStatus {
  state: 'disabled' | 'unconfigured' | 'waiting_session' | 'ready' | 'running' | 'unavailable';
  reason?: string; model?: { provider: string; model: string; reasoningEffort?: string }; executor?: 'native' | 'ptc' | 'unknown';
  jobs?: { jobId: string; state: string; proposals: number; applied: number; error?: ErrorInfo; generationDiagnostics?: GenerationDiagnostics }[];
}
export interface SettingsSnapshot {
  revision: string; writable: boolean; enabled: boolean; config: Partial<DreamConfig>; defaults: Partial<DreamConfig>; inherited: Partial<DreamConfig>;
  configured: boolean; hostTimeZone: string; status: RuntimeStatus; issues: SettingsIssue[];
  sessionOptions: SessionDirectoryItem[];
}
export interface PreflightResult { checks: { id: string; state: 'ready' | 'unavailable' | 'invalid'; message: string }[]; canEnable: boolean }
export class SettingsFailure extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); this.name = 'SettingsFailure'; }
}
