import { join } from 'node:path';
import { validateSnapshot } from '../domain/contracts.js';
import { localDate } from '../scheduler/window.js';
import { collectSnapshot, protectedText } from './materials.js';
import type { DreamConfig, Files, Scope, Snapshot, Source } from '../types.js';
import { errorFields } from '../types.js';

const MAX_OMISSIONS = 64;
const MAX_OMISSION_BYTES = 1024;
const MAX_DIAGNOSTIC_BYTES = 16384;
const MAX_NAME_BYTES = 512;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type Entry = { name: string; isDirectory: boolean };

export interface RecallMaterialCoverage {
  dailyFilesDiscovered: number;
  dailyFilesRead: number;
  dailyFilesOmitted: number;
  bytesRead: number;
  maxBytes: number;
  maxFiles: number;
  truncated: boolean;
  omissions: { sourceId: string; reason: string }[];
  omittedDiagnostics: number;
  meaning: string;
}

function safeName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !/[\/\\\u0000-\u001f\u007f]/u.test(name)
    && !name.includes('..') && Buffer.byteLength(name, 'utf8') <= MAX_NAME_BYTES;
}

/** Exact calendar filenames only; two-digit years mean 2000–2099. */
function diaryDate(name: string): string | undefined {
  const match = /^(\d{4}|\d{2})-(\d{2})-(\d{2})\.md$/u.exec(name);
  if (!match) return;
  const year = match[1].length === 2 ? `20${match[1]}` : match[1];
  if (Number(year) === 0) return;
  const canonical = `${year}-${match[2]}-${match[3]}`;
  const date = new Date(`${canonical}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === canonical ? canonical : undefined;
}

function integer(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} is outside its supported range`);
}

/** Only named, non-authorization failures become whole-file omissions. Unknown
 * failures, permission/sandbox denials and cancellation propagate unchanged. */
function omissionReason(error: unknown): string | undefined {
  switch (errorFields(error).code) {
    case 'ENOENT': return 'missing';
    case 'ENOTDIR': case 'EISDIR': return 'not-regular-file';
    case 'FS_TOO_LARGE': return 'read-byte-budget';
    case 'FS_NOT_TEXT': return 'not-utf8-text';
    case 'FS_STALE_VERSION': case 'FILE_CONFLICT': return 'changed-during-read';
    case 'EIO': return 'unreadable';
    default: return undefined;
  }
}

/** Query-only collection. The unchanged current three-day snapshot keeps its own
 * required-file and input-budget failures. Older daily files are reread locally;
 * no stored summaries, archive/state/dream scans, models, or authority are added. */
export async function collectRecallSnapshot(files: Files, config: DreamConfig, scope: Scope,
  options: { now: Date; snapshotId: string }): Promise<{ snapshot: Snapshot; currentSnapshot: Snapshot; coverage: RecallMaterialCoverage }> {
  integer(config.recallHistoryDays, 0, 3650, 'recallHistoryDays');
  integer(config.maxRecallFiles, 1, 1024, 'maxRecallFiles');
  integer(config.maxRecallBytes, 512, 8 * 1024 * 1024, 'maxRecallBytes');
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) throw new TypeError('now must be a valid Date');
  const daily = join(config.memoryRoot, 'daily');
  const today = localDate(options.now, config.timeZone);
  let listed: Entry[] = [];
  // Capture the one required daily listing used by collectSnapshot. Re-listing
  // could retry a denial or silently mix two directory observations.
  const sourceFiles: Files = {
    read: (path, opts) => files.read(path, opts), stat: path => files.stat(path),
    write: (path, content, version) => files.write(path, content, version),
    mkdir: path => files.mkdir(path), withLock: (key, operation) => files.withLock(key, operation),
    async list(path) {
      const entries = await files.list(path);
      if (path !== daily) {
        if (entries.some(entry => !entry.isDirectory && !safeName(entry.name))) throw new TypeError('Unsafe source filename in configured directory');
        return entries;
      }
      listed = entries.map(entry => ({ ...entry }));
      const names = new Set<string>();
      return entries.filter(entry => {
        if (entry.isDirectory || !safeName(entry.name) || names.has(entry.name)) return false;
        const date = diaryDate(entry.name);
        if (!date || date > today) return false;
        names.add(entry.name);
        return true;
      });
    },
  };
  const currentSnapshot = validateSnapshot(await collectSnapshot(sourceFiles, config, scope, options));
  const snapshot = structuredClone(currentSnapshot);
  const coverage: RecallMaterialCoverage = { dailyFilesDiscovered: 0, dailyFilesRead: 0, dailyFilesOmitted: 0,
    bytesRead: 0, maxBytes: config.maxRecallBytes, maxFiles: config.maxRecallFiles, truncated: false,
    omissions: [], omittedDiagnostics: 0,
    meaning: 'Query-only current raw daily files, not new factual authority. Counts and budgets cover unique non-base .md file entries only, including invalid/future/out-of-window omissions; base snapshot is unchanged and excluded. Lookback includes today through today-minus-historyDays in the configured local calendar; zero disables extension. Newest date then exact path wins file/byte budgets, independent of query or expected answers. bytesRead counts UTF-8 content actually returned by the backend, including rejected oversized reads; failed reads cannot report consumed bytes. Diagnostics omit whole items beyond 64, 1024 bytes/item or 16384 bytes total; no paths are clipped.' };
  let diagnosticBytes = 0;
  const omit = (sourceId: string, reason: string) => {
    coverage.dailyFilesOmitted++;
    coverage.truncated = true;
    const item = { sourceId, reason };
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (coverage.omissions.length >= MAX_OMISSIONS || bytes > MAX_OMISSION_BYTES || diagnosticBytes + bytes > MAX_DIAGNOSTIC_BYTES) coverage.omittedDiagnostics++;
    else { coverage.omissions.push(item); diagnosticBytes += bytes; }
  };
  const first = new Date(`${today}T00:00:00.000Z`);
  first.setUTCDate(first.getUTCDate() - config.recallHistoryDays);
  const oldest = first.toISOString().slice(0, 10);
  const base = new Set(snapshot.sources.map(source => source.sourceId));
  const seen = new Set<string>();
  const candidates: { path: string; date: string }[] = [];
  for (const entry of listed) {
    if (entry.isDirectory || typeof entry.name !== 'string' || !entry.name.endsWith('.md') || seen.has(entry.name)) continue;
    seen.add(entry.name);
    const path = `daily/${entry.name}`;
    if (base.has(path)) continue;
    coverage.dailyFilesDiscovered++;
    if (!safeName(entry.name)) { omit(path, 'unsafe-or-oversized-filename'); continue; }
    const date = diaryDate(entry.name);
    if (!date) { omit(path, 'invalid-calendar-filename'); continue; }
    if (date > today) { omit(path, 'future-date'); continue; }
    if (config.recallHistoryDays === 0) { omit(path, 'history-disabled'); continue; }
    if (date < oldest) { omit(path, 'outside-lookback'); continue; }
    candidates.push({ path, date });
  }
  candidates.sort((a, b) => compare(b.date, a.date) || compare(a.path, b.path));
  for (const candidate of candidates) {
    const { path } = candidate;
    if (coverage.dailyFilesRead >= config.maxRecallFiles) { omit(path, 'history-file-budget'); continue; }
    const remaining = config.maxRecallBytes - coverage.bytesRead;
    if (remaining <= 0) { omit(path, 'history-byte-budget'); continue; }
    const maxBytes = Math.min(config.maxSourceBytes, remaining);
    const physical = join(config.memoryRoot, path);
    let info;
    try { info = await files.stat(physical); }
    catch (error) {
      const reason = omissionReason(error);
      if (!reason) throw error;
      omit(path, reason); continue;
    }
    if (!info) { omit(path, 'missing'); continue; }
    if (info.type !== 'file') { omit(path, 'not-regular-file'); continue; }
    if (info.size !== undefined && (!Number.isSafeInteger(info.size) || info.size < 0)) { omit(path, 'invalid-size-metadata'); continue; }
    if (info.size !== undefined && info.size > maxBytes) { omit(path, info.size > config.maxSourceBytes ? 'source-byte-budget' : 'history-byte-budget'); continue; }
    let file;
    try { file = await files.read(physical, { maxBytes }); }
    catch (error) {
      const reason = omissionReason(error);
      if (!reason) throw error;
      omit(path, reason); continue;
    }
    if (!file) { omit(path, 'missing'); continue; }
    if (typeof file.content !== 'string') throw new TypeError('Historical source backend returned non-text content');
    const bytes = Buffer.byteLength(file.content, 'utf8');
    coverage.bytesRead += bytes;
    if (bytes > maxBytes) { omit(path, 'backend-read-budget-exceeded'); continue; }
    const source: Source = { sourceId: path, path, role: 'daily', content: file.content,
      version: structuredClone(file.version), writable: false,
      sensitivity: /<!--\s*sensitive\s*-->/i.test(file.content) ? 'sensitive' : 'private',
      protectedText: protectedText(file.content, 'daily') };
    // Invalid externally supplied versions must not become a retrieval source.
    validateSnapshot({ ...snapshot, sources: [source] });
    snapshot.sources.push(source);
    coverage.dailyFilesRead++;
  }
  return { snapshot: validateSnapshot(snapshot), currentSnapshot, coverage };
}
