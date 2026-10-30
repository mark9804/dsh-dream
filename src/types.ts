/** Domain records. External JSON is validated by domain/contracts before use. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Version = Json;
export type State = 'queued' | 'collecting' | 'generating' | 'awaiting_review' | 'prepared' | 'applying' | 'applied' | 'awaiting_compaction' | 'compacting' | 'awaiting_reload' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'reviewed_no_changes';
export interface Scope { scopeId: string; agentId: string; sessionId: string; memoryRootId: string }
export type Role = 'daily' | 'journal' | 'ideas' | 'longTerm' | 'decisions' | 'persona';
export interface Source { sourceId: string; path: string; role: Role; content: string; version: Version; writable: boolean; sensitivity: 'private' | 'sensitive'; protectedText: string[] }
export interface Snapshot { schemaVersion: 1; snapshotId: string; scope: Scope; capturedAt: string; sources: Source[] }
export interface Proposal { schemaVersion: 1; proposalId: string; jobId: string; kind: 'fact' | 'preference' | 'personality' | 'commitment' | 'feeling'; text: string; reason: string; impact?: string; evidence: { sourceId: string; quote: string }[]; targetId: string; operation: 'append' | 'replace' | 'archive'; before: string; after: string }
export interface Actor { agentId: string; sessionId: string }
export type Decision = 'accept' | 'reject' | 'defer';
export interface ReviewInput { jobId: string; proposalId: string; decision: Decision; reason: string }
/** Chat may request isolated review or veto, but never supplies acceptance authority. */
export interface ReviewRequest { jobId: string; proposalId: string; decision: 'review' | 'reject' | 'defer'; reason: string }
export interface CleanReviewAuthority { kind: 'clean-model'; policyVersion: 1; inputDigest: string; callId: string; provider: string; model: string }
export interface CleanReviewResult { decision: Decision; reason: string; authority: CleanReviewAuthority }
export type CleanReviewer = (snapshot: Snapshot, proposal: Proposal, options?: { signal?: AbortSignal }) => Promise<CleanReviewResult>;
export interface Review { schemaVersion: 1; reviewId: string; proposalId: string; jobId: string; reviewer: Actor; decision: Decision; reason: string; reviewedAt: string; proposalSnapshot: Proposal; authority?: CleanReviewAuthority; basis: { scope: Scope; sources: Source[] } }
export interface Change { targetId: string; before: string; after: string; version: Version }
export interface ChangeSet { schemaVersion: 1; transactionId: string; jobId: string; proposalIds: string[]; reviewIds: string[]; status: 'prepared' | 'applying' | 'applied'; changes: Change[] }
export interface ErrorInfo { code: string; message: string }
export interface DeliveryAttempt { messageId: string; state: 'queued' | 'sent' | 'failed' | 'uncertain'; at: string; sentAt?: string; error?: ErrorInfo }
export interface Delivery extends DeliveryAttempt { history: DeliveryAttempt[] }
export type DeliveryField = 'reviewDelivery' | 'reloadDelivery' | 'reportDelivery' | 'attentionDelivery' | 'compactionPauseDelivery' | 'compactionDecisionDelivery';
export interface ReloadSource { sourceId: string; path: string; version: Version; content: string }
export interface ContextPressure { totalTokens?: number; contextWindow?: number; baseline?: 'none' | 'estimated' | 'usage'; provider?: string; model?: string; logRevision?: number; unavailableReason?: string }
export interface CompactionInput { jobId: string; transactionId: string; decision: 'compact' | 'skip'; reason: string }
export interface Job extends Partial<Record<DeliveryField, Delivery>> {
 compactionChoice?: { transactionId: string; decision: 'compact' | 'skip'; reason: string; actor: Actor; at: string; pressure: ContextPressure };
 schemaVersion: 1; jobId: string; scope: Scope; snapshot: Snapshot; state: State; proposals: Proposal[]; reviews: Review[]; appliedProposalIds: string[]; committingProposalIds?: string[]; createdAt: string; updatedAt: string;
 invalidatedReviewIds?: string[]; appliedTransactionIds?: string[]; phase?: State; checkpoint?: { state: State; transactionId?: string }; error?: ErrorInfo; transaction?: ChangeSet;
 inputFingerprint?: string; processedFingerprint?: string; processedSnapshot?: Snapshot; dreamPath?: string; compactionAttempts?: number;
 recovery?: { action: string; message: string; transactionId?: string }; compaction?: { status: 'no_op' | 'completed' | 'skipped'; compactionId?: string };
 reload?: { transactionId: string; status?: 'preparing' | 'ready'; sources?: ReloadSource[]; acknowledgedAt?: string };
 abandonedTransactions?: { transactionId: string; reason?: string; at: string }[];
}
export interface DreamResult { dream: string; proposals: Proposal[]; dreamDate?: string; executorThreadId?: number }
export interface DreamConfig { sessionId: string; memoryRoot: string; stateRoot: string; personaPath?: string; start: string; end: string; timeZone: string; maxSourceBytes: number; maxInputBytes: number; maxOutputBytes: number; maxProposals: number; timeoutMs: number; compactionMode: 'auto' | 'manual' | 'agent'; singleRun: boolean }
export interface ReadOptions { maxBytes?: number; signal?: AbortSignal }
export interface FileContent { content: string; version: Version }
export interface FileInfo { type: string; size?: number; version?: Version }
export interface Files { read(path: string, options?: ReadOptions): Promise<FileContent | null>; write(path: string, content: string, version: Version): Promise<Version>; mkdir(path: string): Promise<void>; list(path: string): Promise<{ name: string; isDirectory: boolean }[]>; stat(path: string): Promise<FileInfo | null>; withLock<T>(key: string, operation: () => Promise<T>): Promise<T> }
export type Model = (prompt: string, options?: { signal?: AbortSignal }) => Promise<string>;
export type Generate = (snapshot: Snapshot, jobId: string, options?: { signal?: AbortSignal }) => Promise<DreamResult>;
export interface Metadata { messageId?: string; purpose?: string; jobId?: string; transactionId?: string }
export interface HostControl { contextPressure?(): ContextPressure; notify(text: string, metadata?: Metadata): Promise<unknown>; requestReview(text: string, metadata?: Metadata): Promise<unknown>; requestReload(text: string, metadata?: Metadata): Promise<unknown>; waitForIdle(signal?: AbortSignal): Promise<void>; maintain<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>; compact(signal?: AbortSignal): Promise<{ compactionId: string } | null> }
export interface ManifestEntry { targetId: string; path: string; before: string; after: string; existed: boolean; backup: string | null; done: boolean }
export interface Manifest { schemaVersion: 1; transactionId: string; jobId: string; status: 'prepared' | 'applying' | 'applied' | 'cancelled'; changeSet: ChangeSet; entries: ManifestEntry[]; sources: ReloadSource[]; writeStarted?: boolean; appliedAt?: string; cancelledAt?: string; cancellationReason?: string }
export type AfterStep = (step: { phase: string; index?: number; manifest: Manifest }) => unknown | Promise<unknown>;
/** Preserve foreign thrown values; only their existing error-shaped fields are read. */
export function errorFields(value: unknown): { code?: string; message?: string; dreamHandled?: boolean } {
 return value !== null && (typeof value === 'object' || typeof value === 'function') ? value as { code?: string; message?: string; dreamHandled?: boolean } : {};
}
