import type { GenerationStage } from './generation-diagnostics.js';
/** Shared data-only private debugging contracts, safe for browser type imports. */
export interface QuoteValidationIssue {
  kind: 'quote-not-found'; episodeIndex: number; evidenceIndex: number; episodeId: string; sourceId: string; sourcePath?: string;
  quote: string; quoteTruncated: boolean;
  nearest: null | { text: string; start: number; end: number; lineStart: number; lineEnd: number; similarity: number };
  algorithm: 'character-bigram-dice-v1';
  search: { sourceCharacters: number; searchedCharacters: number; candidates: number; truncated: boolean };
  debugOnly: true; exactMatch: false;
}
export interface GenerationAttemptDetails {
  attemptId: string; attemptPath?: string; stage: GenerationStage; validationIssue?: QuoteValidationIssue;
  archiveState: 'saved' | 'failed'; archiveErrorCode?: string;
}
