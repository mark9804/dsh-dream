import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { configurationDefaults, validateConfig } from '../config.js';
import { apply as runDream } from '../index.js';
import type { HostContext, Agent } from '../harness/types.js';
import { createRuntimeContext, nativeExecutor } from '../harness/runtime-context.js';
import { configurationIssues, resolvedDraft, validateSettingsConfiguration } from './configuration.js';
import type { SettingsConfiguration } from './configuration.js';
import { SettingsFailure } from './contracts.js';
import type { PreflightResult, RuntimeStatus, SettingsSnapshot } from './contracts.js';
import type { DreamConfig } from '../types.js';
import type { createEngine } from '../engine.js';
import { createSettingsSessionDirectory } from './sessions.js';
import { buildDreamModelCatalog, validateModelChoices, modelChoiceFields } from './models.js';

type Entry = { id?: string; options?: { id?: string; name?: string; config?: unknown }; fiber?: unknown };
interface Editor { entries(): Entry[]; configuration(): { entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }[]; edit(entry: Entry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void> }
interface Query {
  listSessions(signal?: AbortSignal): Promise<{ header: { id: string; cwd?: string }; live: boolean; persisted: boolean }[]>;
  readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<{ sessionId: string; status: string; value?: { title?: { title: string } } }[]>;
  observeSession(sessionId: string, options: { signal?: AbortSignal; projectionMode: 'none' }): Promise<{ header: { id: string }; events: readonly unknown[]; [Symbol.dispose](): void }>;
  searchEvents(request: { sessionId: string; query: string; limit: number; cursor?: string; filters: { kind: 'type'; values: string[] }[] }): Promise<{ items: { seq: number }[]; nextCursor?: string; session: { id: string } }>;
  readEvent(request: { sessionId: string; seq: number; before: number; after: number }, signal?: AbortSignal): Promise<unknown>;
}
export type SettingsContext = HostContext & { get(name: string): any; fiber?: { entry?: Entry }; connection?: unknown; [key: string]: unknown };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function request(v: unknown, allowed: string[]) { if (!record(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new SettingsFailure('INVALID_REQUEST', 'Unsupported settings request'); return v; }
function text(v: unknown, field: string, max = 4096): string { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new SettingsFailure('INVALID_REQUEST', `Invalid ${field}`); return v; }

/** Owns public settings state, never opens memory files while disabled. All writes
 * flow through configEditor; the public HTTP carrier is strictly owner-only. */
export function createSettingsService(ctx: SettingsContext, configurationEntryId = 'dsh-dream-configuration') {
  let settings: SettingsConfiguration = { enabled: false, configuration: {} }, ownerContext: HostContext | undefined;
  let engine: ReturnType<typeof createEngine> | undefined, engineAgent: Agent | undefined, runError: string | undefined, mountGeneration = 0;
  let active = false;
  const sessionDirectory = createSettingsSessionDirectory(ctx);
  const currentEntry = () => (ctx.get('configEditor') as Editor | undefined)?.entries().find(e => (e.options?.id ?? e.id) === configurationEntryId);
  const metadata = () => {
    const editor = ctx.get('configEditor') as Editor | undefined, entry = currentEntry();
    const layer = entry && editor?.configuration().find(row => row.entry === entry);
    const raw = entry?.options?.config ?? settings;
    return { editor, entry, raw, inherited: layer?.inherited ?? {}, revision: hash({ raw, inherited: layer?.inherited ?? {}, active }) };
  };
  async function preflight(input: unknown): Promise<PreflightResult> {
    const args = request(input, ['config']); const checks: PreflightResult['checks'] = [];
    let config: DreamConfig;
    try { config = validateConfig(args.config); checks.push({ id: 'configuration', state: 'ready', message: 'Configuration is valid' }); }
    catch (error) { return { checks: [{ id: 'configuration', state: 'invalid', message: error instanceof Error ? error.message : String(error) }], canEnable: false }; }
    const agent = ctx.agents.get(config.sessionId);
    if (!agent) return { checks: [...checks, { id: 'session', state: 'unavailable', message: 'Open the explicitly selected target session before enabling Dream' }], canEnable: false };
    checks.push({ id: 'session', state: 'ready', message: 'Target session is live' });
    const runtime = createRuntimeContext(ownerContext ?? ctx, agent);
    let selection;
    try { selection = agent.model ? agent.model.current() : agent.session.requestHeader?.()?.config ?? agent.options; if (!selection?.provider || !selection.model) throw Error('No configured model route'); checks.push({ id: 'model', state: 'ready', message: `${selection.provider}/${selection.model}` }); }
    catch (error) { checks.push({ id: 'model', state: 'unavailable', message: error instanceof Error ? error.message : String(error) }); }
    try {
      const issues = await validateModelChoices(runtime, config, agent);
      checks.push(...issues.map(issue => ({ id: issue.field, state: 'invalid' as const, message: issue.message })));
    } catch { checks.push({ id: 'models', state: 'unavailable', message: 'Unable to validate explicit Dream model choices; refresh the model directory' }); }
    checks.push(typeof runtime.compaction?.compactNow === 'function' ? { id: 'compaction', state: 'ready', message: 'Target composition provides native compaction' } : { id: 'compaction', state: 'unavailable', message: 'Target composition has no compaction backend' });
    const executor = nativeExecutor(runtime, agent);
    checks.push(executor === 'native' ? { id: 'executor', state: 'ready', message: 'Native tool executor is available' } : { id: 'executor', state: 'unavailable', message: executor === 'ptc' ? 'This settings-managed first release requires a native executor; PTC nonce receipt fallback is not fully verified' : 'Cannot determine the target tool executor' });
    try {
      const fs = runtime.fs;
      const memory = await fs.resolve(config.memoryRoot), state = await fs.resolve(config.stateRoot);
      const policy = runtime.sandboxPolicy?.resolve({ session: agent.session }) as { mode?: string; workspaceRoot?: string; additionalWritableRoots?: readonly string[] } | undefined;
      if (fs.contains(memory, state) || fs.contains(state, memory)) throw Error('Memory and task-state directories must not overlap');
      for (const [id, path] of [['memory', config.memoryRoot], ['state', config.stateRoot], ...(config.personaPath ? [['persona', config.personaPath]] : [])]) {
        const target = await fs.resolve(path); const info = await fs.stat(target);
        if (id === 'memory' && info?.type !== 'directory' || id === 'persona' && info?.type !== 'file' || id === 'state' && info && info.type !== 'directory') throw Error(`Invalid ${id} path`);
        if (policy?.mode === 'read-only') throw Error('Session filesystem is read-only');
        if (policy?.mode === 'workspace-write') {
          const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])].filter((p): p is string => typeof p === 'string');
          let allowed = false; for (const root of roots) if (fs.contains(await fs.resolve(root), target)) allowed = true;
          if (!allowed) throw Error(`${id} path is outside target-session writable roots`);
        }
      }
      for (const item of ['daily', 'ideas', 'long-term.md', 'decisions.md', 'journal.md']) {
        const expected = item === 'daily' || item === 'ideas' ? 'directory' : 'file';
        const info = await fs.stat(await fs.resolve(join(config.memoryRoot, item)));
        if (info?.type !== expected) throw Error(`Required memory layout is missing: ${item}`);
      }
      checks.push({ id: 'paths', state: 'ready', message: 'Path identities, layout and session policy checked without reading content or test-writing' });
    } catch (error) { checks.push({ id: 'paths', state: 'invalid', message: error instanceof Error ? error.message : String(error) }); }
    return { checks, canEnable: checks.every(c => c.state === 'ready') };
  }
  async function status(): Promise<RuntimeStatus> {
    if (!settings.enabled) return { state: configurationIssues(resolvedDraft(settings.configuration)).length ? 'unconfigured' : 'disabled' };
    if (runError) return { state: 'unavailable', reason: runError };
    const agent = ctx.agents.get(settings.configuration.sessionId!);
    if (!agent) return { state: 'waiting_session' };
    const runtime = createRuntimeContext(ownerContext ?? ctx, agent), selection = agent.model ? agent.model.current() : agent.session.requestHeader?.()?.config ?? agent.options;
    const jobs = engine ? (await engine.status({})).jobs ?? [] : [];
    return { state: engine && jobs.some(j => !['completed', 'reviewed_no_changes', 'failed', 'cancelled', 'skipped'].includes(j.state)) ? 'running' : engine ? 'ready' : 'unavailable',
      ...(!engine ? { reason: 'Target runtime not bound' } : {}), executor: nativeExecutor(runtime, agent),
      ...(selection?.provider && selection.model ? { model: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) } } : {}), jobs: jobs.map(j => ({ jobId: j.jobId, state: j.state, proposals: j.proposals, applied: j.applied, ...(j.error ? { error: j.error } : {}), ...(j.generationDiagnostics ? { generationDiagnostics: j.generationDiagnostics } : {}) })) };
  }
  async function read(signal?: AbortSignal): Promise<SettingsSnapshot> {
    signal?.throwIfAborted();
    const m = metadata(), config = resolvedDraft(settings.configuration), issues = configurationIssues(config);
    const inheritedDoc = record(m.inherited.configuration) ? m.inherited.configuration : {};
    const writable = !!m.editor && !!m.entry && active, enabled = settings.enabled;
    const runtimeStatus = await status();
    const ids = [config.sessionId, ...(config.sourceSessionIds ?? [])].filter((id): id is string => typeof id === 'string' && !!id);
    let sessionOptions: SettingsSnapshot['sessionOptions'] = [];
    if (ids.length) {
      try { sessionOptions = await sessionDirectory.resolveSelected(ids, signal); }
      catch { signal?.throwIfAborted(); sessionOptions = [...new Set(ids)].map(id => ({ id, title: id, live: false })); }
    }
    signal?.throwIfAborted();
    return { revision: m.revision, writable, enabled, config, defaults: configurationDefaults(), inherited: resolvedDraft(inheritedDoc), configured: issues.length === 0, hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, status: runtimeStatus, issues, sessionOptions };
  }
  async function save(input: unknown): Promise<SettingsSnapshot> {
    const args = request(input, ['revision', 'config', 'enabled', 'confirmEnable', 'confirmScope']); text(args.revision, 'revision', 128);
    if (typeof args.enabled !== 'boolean' || !record(args.config) || args.confirmEnable !== undefined && args.confirmEnable !== true || args.confirmScope !== undefined && args.confirmScope !== true) throw new SettingsFailure('INVALID_REQUEST', 'Save requires an explicit config, enabled flag and valid confirmations');
    const candidate = validateSettingsConfiguration({ enabled: args.enabled, configuration: args.config });
    const old = settings.configuration;
    const scopeChanged = ['sessionId', 'memoryRoot', 'stateRoot', 'personaPath', 'sourceSessionIds', 'originalSources', 'dreamContextRefs'].some(k => !isDeepStrictEqual(old[k as keyof DreamConfig], candidate.configuration[k as keyof DreamConfig]));
    if (candidate.enabled && (!settings.enabled || scopeChanged) && args.confirmEnable !== true) throw new SettingsFailure('CONFIRM_ENABLE', 'Enabling or retargeting Dream requires explicit confirmation');
    if (scopeChanged && settings.configuration.sessionId && args.confirmScope !== true) throw new SettingsFailure('CONFIRM_SCOPE', 'Changing target or source permissions requires explicit confirmation');
    if (candidate.enabled) { const result = await preflight({ config: candidate.configuration }); if (!result.canEnable) throw new SettingsFailure('PREFLIGHT_FAILED', 'Cannot enable Dream until all readiness checks pass', result); }
    const changedModelConfig = Object.fromEntries(modelChoiceFields.filter(field => !isDeepStrictEqual(settings.configuration[field], candidate.configuration[field]) || settings.configuration.sessionId !== candidate.configuration.sessionId).map(field => [field, candidate.configuration[field]])) as Partial<DreamConfig>;
    if (!candidate.enabled && Object.values(changedModelConfig).some(choice => choice && Object.keys(choice).length > 0)) {
      const agent = candidate.configuration.sessionId ? ctx.agents.get(candidate.configuration.sessionId) : undefined;
      const modelContext = agent ? createRuntimeContext(ownerContext ?? ctx, agent) : ownerContext ?? ctx;
      const modelIssues = await validateModelChoices(modelContext, changedModelConfig, agent);
      if (modelIssues.length) throw new SettingsFailure('INVALID_CONFIGURATION', 'Dream model or reasoning selection is unavailable', modelIssues);
    }
    const m = metadata(); if (!m.editor || !m.entry || !active) throw new SettingsFailure('UNAVAILABLE', 'Settings configuration owner is unavailable');
    await m.editor.edit(m.entry, (current, inherited) => {
      if (hash({ raw: current, inherited, active }) !== args.revision) throw new SettingsFailure('SETTINGS_CONFLICT', 'Settings changed; refresh the current values without discarding your draft');
      return candidate as unknown as Record<string, unknown>;
    });
    return read();
  }
  async function sessions(input: unknown, signal?: AbortSignal) {
    const args = request(input, ['query']); const query = args.query === undefined || args.query === '' ? '' : text(args.query, 'query', 512);
    return sessionDirectory.search(query, signal);
  }
  async function messages(input: unknown) {
    const args = request(input, ['sessionId', 'query', 'cursor']); const sessionId = text(args.sessionId, 'sessionId');
    if (![settings.configuration.sessionId, ...(settings.configuration.sourceSessionIds ?? [])].includes(sessionId)) throw new SettingsFailure('SESSION_NOT_AUTHORIZED', 'Save this explicitly authorized source session before browsing its messages');
    const service = ctx.get('sessionQuery') as Query | undefined; if (!service) throw new SettingsFailure('UNAVAILABLE', 'Exact source-message query unavailable');
    const query = args.query === undefined || args.query === '' ? '' : text(args.query, 'query', 512);
    if (args.cursor !== undefined) text(args.cursor, 'cursor', 4096);
    // One explicit UI request retains a coherent observation and emits bounded
    // public text only. No prompt, reasoning, tools or summary is a source pick.
    const observation = await service.observeSession(sessionId, { projectionMode: 'none' });
    try {
      if (observation.header.id !== sessionId) throw new SettingsFailure('UNAVAILABLE', 'Message observation identity mismatch');
      let candidates: readonly unknown[], nextCursor: string | undefined;
      if (query) {
        const page = await service.searchEvents({ sessionId, query, limit: 12, ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}), filters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }] });
        if (page.session.id !== sessionId) throw new SettingsFailure('UNAVAILABLE', 'Message search identity mismatch');
        const seqs = new Set(page.items.map(item => item.seq)); candidates = observation.events.filter((e: unknown) => record(e) && seqs.has(e.seq as number)); nextCursor = page.nextCursor;
      } else {
        const before = args.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(args.cursor);
        if (!Number.isSafeInteger(before) || before < 0) throw new SettingsFailure('INVALID_REQUEST', 'Invalid message page cursor');
        const publicEvents = observation.events.filter((e: unknown) => record(e) && typeof e.seq === 'number' && e.seq < before && ['user/message', 'assistant/message'].includes(String(e.type)));
        candidates = publicEvents.slice(-12).reverse();
        if (publicEvents.length > candidates.length && candidates.length) nextCursor = String((candidates[candidates.length - 1] as Record<string, unknown>).seq);
      }
      const replaced = new Set<number>();
      for (const raw of observation.events) if (record(raw) && record(raw.surfaceOp) && raw.surfaceOp.op === 'replace' && typeof raw.surfaceOp.startSeq === 'number' && typeof raw.surfaceOp.endSeq === 'number') {
        for (const event of candidates) if (record(event) && typeof event.seq === 'number' && event.seq >= raw.surfaceOp.startSeq && event.seq <= raw.surfaceOp.endSeq) replaced.add(event.seq);
      }
      let remaining = 65536, omitted = false;
      const items = candidates.flatMap((e: unknown) => {
        if (!record(e) || !record(e.data) || !Number.isSafeInteger(e.seq) || replaced.has(e.seq as number) || e.surfaceOp !== 'append' || e.data.interrupted === true || e.data.error !== undefined || Array.isArray(e.sourceEventSeqs) && e.sourceEventSeqs.length) return [];
        const message = e.type === 'user/message' ? e.data : e.data.message;
        if (!record(message) || message.isError === true || !record(message.source) || !['user', 'model'].includes(String(message.source.kind)) || !Array.isArray(message.content)) return [];
        const blocks = message.content.flatMap((b: unknown, blockIndex: number) => {
          if (!record(b) || b.type !== 'text' || typeof b.text !== 'string') return [];
          const size = Buffer.byteLength(b.text); if (size > 16384 || size > remaining) { omitted = true; return []; } remaining -= size;
          return [{ blockIndex, text: b.text }];
        });
        return blocks.length ? [{ sessionId, seq: e.seq as number, role: String(message.role), text: blocks.map(b => b.text).join('\n'), blocks }] : [];
      });
      return { items, ...(nextCursor !== undefined ? { cursor: nextCursor } : {}), truncated: nextCursor !== undefined || omitted };
    } finally { observation[Symbol.dispose](); }
  }
  return {
    async models(input: unknown, signal?: AbortSignal) {
      const args = request(input, ['sessionId']); signal?.throwIfAborted();
      if (args.sessionId !== undefined) text(args.sessionId, 'sessionId', 512);
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : settings.configuration.sessionId;
      const agent = sessionId ? ctx.agents.get(sessionId) : undefined;
      const runtime = agent ? createRuntimeContext(ownerContext ?? ctx, agent) : ownerContext ?? ctx;
      return buildDreamModelCatalog(runtime, agent, signal);
    },
    read, save, preflight, status, sessions, messages, dispose: sessionDirectory.dispose, invalidateSessions: sessionDirectory.invalidate,
    mount(context: HostContext, config: SettingsConfiguration) {
      const generation = ++mountGeneration; settings = structuredClone(config); ownerContext = context; active = true; runError = undefined;
      let dispose: unknown;
      if (settings.enabled) {
        try { dispose = runDream(context, settings.configuration, {
          async beforeBind() { const result = await preflight({ config: settings.configuration }); if (!result.canEnable) throw new SettingsFailure('PREFLIGHT_FAILED', 'Target runtime is not ready; business remains paused', result); if (generation === mountGeneration) runError = undefined; },
          failed(error) { if (generation === mountGeneration) runError = error instanceof Error ? error.message : String(error); },
          bind(next, agent) { if (generation === mountGeneration) { engine = next; engineAgent = agent; } }, unbind(agent) { if (engineAgent === agent) { engine = undefined; engineAgent = undefined; } } }); }
        catch (error) { runError = error instanceof Error ? error.message : String(error); context.logger?.error(error); }
      }
      return async () => {
        if (generation === mountGeneration) { active = false; engine = undefined; engineAgent = undefined; ownerContext = undefined; }
        // ctx.effect owns runDream disposal. It is drained by Loader before a
        // changed configuration owner publishes its new mount.
        if (typeof dispose === 'function') await dispose();
      };
    },
  };
}
