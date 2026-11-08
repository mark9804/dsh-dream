import type { DreamConfig } from '../types.js';
import type { SessionDirectoryItem } from './sessions.js';
import type { GenerationDiagnostics } from '../domain/generation-diagnostics.js';
export interface SettingsIssue { field?: string; message: string }
export interface RuntimeStatus {
  state: 'disabled' | 'unconfigured' | 'waiting_session' | 'ready' | 'running' | 'unavailable';
  reason?: string; model?: { provider: string; model: string; reasoningEffort?: string }; executor?: 'native' | 'ptc' | 'unknown';
  jobs?: { jobId: string; state: string; proposals: number; applied: number; error?: { code: string; message: string }; generationDiagnostics?: GenerationDiagnostics }[];
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
