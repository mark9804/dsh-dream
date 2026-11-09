import type { Version, FileInfo, Metadata, Actor, ReviewRequest, ReviewBatchRequest, ReloadReadRequest, ReloadAckInput, CompactionInput, RecallRequest, ReinforcementRequest } from '../types.js';
/** Minimal structural seams consumed by this adapter, verified in docs/harness-integration.md.
 * These are not a replacement Host SDK and expose no additional authority. */
export interface CallConfig { provider?: string; model?: string; maxTokens?: number; reasoningEffort?: string; temperature?: number; stop?: string[] }
export interface Session { id: string; eventAt?(seq: number): { type: string; data: unknown } | undefined; requestHeader?(): { config: CallConfig; adapterDefaults?: { reasoningEffort?: true; maxTokens?: true } } | undefined; requestContext?(): { provider: string; model: string; contextWindow?: number } | undefined }
export interface Agent { id: string; session: Session; options?: CallConfig; model?: { current(): CallConfig | undefined }; ctx: ToolContext; followup(message: { id: string; role: 'user'; content: { type: 'text'; text: string }[]; source: Metadata & { kind: string } }): unknown; whenIdle(): Promise<void>; runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> }
export interface FileTarget { targetKey: string }
export interface HostFs {
 sandboxMode?: unknown;
 resolve(path: string, options?: { signal?: AbortSignal }): Promise<FileTarget>;
 contains(root: FileTarget, target: FileTarget): boolean;
 stat(target: FileTarget, signal?: AbortSignal): Promise<FileInfo | null>;
 readText(target: FileTarget, signal?: AbortSignal): Promise<string>;
 readBytes?(target: FileTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
 listDir(target: FileTarget, signal?: AbortSignal): Promise<{ name: string; type: string }[]>;
 writeText(target: FileTarget, content: string, guard: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: Version }, signal?: AbortSignal, policy?: unknown): Promise<{ version: Version }>;
}
export type StreamChunk = { type: 'finish'; reason: { kind: string } } | { type: 'text-delta'; index: number; text: string } | { type: 'block-end'; index: number; block: { type: string; text?: string } } | { type: 'tool-call-delta' | 'block-start' | 'reasoning-delta' | 'usage' };
export interface Execution { agent: Agent; signal?: AbortSignal; callId?: string; parent?: unknown; concludeTurn?(): void }
export interface ToolContext { tools: { register(definition: { name: string; description: string; parameters: unknown; output: { schema: unknown; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }; execute(args: unknown, execution: Execution): Promise<unknown> }): () => void } }
export interface HostEventMap {
  'agent/created': (event: { agent: Agent }) => void;
  'agent/disposed': (event: { agent: Agent }) => void;
  'agent/inbox/claimed': (event: { agent: Agent; message: unknown; turn: number }) => void;
  'agent/pre-step': (event: { agent: Agent; messages: unknown[]; turn: number; step: number; modelSelection?: Readonly<CallConfig> }, next: () => Promise<unknown>) => Promise<unknown>;
  'session/created': (session: Session) => void;
  'session/disposed': (session: Session) => void;
  'session/event': (session: Session, event: { type: string; data: unknown; seq?: number; surfaceOp?: unknown; sourceEventSeqs?: readonly number[] }) => void;
}
export interface ModelReasoningInfo { efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }
export interface ModelInfo { provider: string; id: string; name: string; description?: string; reasoning?: ModelReasoningInfo }
export interface HostContext extends ToolContext {
 get?(key: 'tokenMeter'): { measure(session: Session): { totalTokens: number; baseline: { kind: 'none' | 'estimated' | 'usage' }; logRevision: number } } | undefined;
 fs: HostFs;
 sandboxPolicy?: { resolve(input: { session: Session }): unknown };
 llm: { prepareCall(config: CallConfig, signal?: AbortSignal): Promise<{ config: CallConfig; stream(input: CallConfig & { messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]; sessionId: string; signal?: AbortSignal }): AsyncIterable<StreamChunk> }>;
  listProviders?(): { id: string; name: string }[];
  listModels?(provider: string): Promise<ModelInfo[]>;
  resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>;
  resolveCallConfig?(config: CallConfig, signal?: AbortSignal): Promise<CallConfig>;
 };
 compaction: { compactNow(agent: Agent, signal?: AbortSignal): Promise<{ compactionId: string } | null> };
 agents: { get(sessionId: string): Agent | undefined };
 effect(callback: () => () => Promise<void>): unknown;
 on<K extends keyof HostEventMap>(event: K, callback: HostEventMap[K]): () => void;
 logger?: { error(error: unknown): void };
}
export interface ToolArguments { recall: RecallRequest; reinforcement: ReinforcementRequest; decideCompaction: CompactionInput; status: { jobId?: string }; review: ReviewRequest; reviewBatch: ReviewBatchRequest; readReload: ReloadReadRequest; submit: { jobId: string }; ackReload: ReloadAckInput; retry: { jobId: string; branch?: 'memory' | 'dream' } }
export type HandlerContext = Execution & { actor: Actor };
export type Handlers = { [K in keyof ToolArguments]?: (args: ToolArguments[K], context: HandlerContext) => unknown | Promise<unknown> };
