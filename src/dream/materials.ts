import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { recentDates } from '../scheduler/window.js';

import type { Files, DreamConfig, Scope, Snapshot, Source, Role } from '../types.js';
import { errorFields } from '../types.js';

const protectedHeading = /pinned|不可淘汰|不可修改|称呼|红线|研究方向|论文|(?:正在)?进行中?的?约定|ongoing commitments|research|boundaries/i;

/** Explicit pin blocks and protected Markdown sections are retained verbatim. */
export function protectedText(content: string, role: Role) {
  const spans = [...content.matchAll(/<!--\s*pinned:start\s*-->[\s\S]*?<!--\s*pinned:end\s*-->/g)].map(m => m[0]);
  const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  for (let i = 0; i < headings.length; i++) {
    if (!protectedHeading.test(headings[i][2])) continue;
    const next = headings.slice(i + 1).find(h => h[1].length <= headings[i][1].length);
    spans.push(content.slice(headings[i].index, next?.index ?? content.length));
  }
  // Unmarked existing persona text stays intact; reviewed traits can be appended.
  if (role === 'persona' && content && !spans.length) spans.push(content);
  return [...new Set(spans)];
}

/** Read only the configured memory layout; an absent required file is an error. */
export async function collectSnapshot(files: Files, config: DreamConfig, scope: Scope, { now, snapshotId }: { now: Date; snapshotId: string }): Promise<Snapshot> {
  const entries: [Role, string, boolean][] = [
    ['longTerm', 'long-term.md', true], ['decisions', 'decisions.md', true],
    ['journal', 'journal.md', false],
  ];
  const dates = new Set(recentDates(now, config.timeZone));
  for (const role of ['daily', 'ideas'] as const) {
    const directory = join(config.memoryRoot, role);
    if ((await files.stat(directory))?.type !== 'directory') throw new Error(`Missing configured directory: ${role}`);
    for (const entry of await files.list(directory)) {
      if (entry.isDirectory || !entry.name.endsWith('.md')) continue;
      if (role === 'daily') {
        let date = entry.name.slice(0, -3);
        if (/^\d{2}-\d{2}-\d{2}$/.test(date)) date = `20${date}`;
        if (!dates.has(date)) continue;
      }
      entries.push([role, `${role}/${entry.name}`, false]);
    }
  }
  if (config.personaPath) entries.push(['persona', 'AGENTS.md', true]);
  const sources: Source[] = [];
  let total = 0;
  for (const [role, path, writable] of entries.sort((a, b) => a[1].localeCompare(b[1]))) {
    const physical = role === 'persona' ? config.personaPath! : join(config.memoryRoot, path);
    const maxBytes = Math.min(config.maxSourceBytes, config.maxInputBytes - total);
    const info = await files.stat(physical);
    if (!info) throw new Error(`Missing configured source: ${path}`);
    if (info.type !== 'file') throw new Error(`Expected a regular source file: ${path}`);
    if (info.size! > maxBytes) throw new Error(`Material budget exceeded at ${path}`);
    let file;
    try { file = await files.read(physical, { maxBytes }); }
    catch (error) {
      if (errorFields(error).code === 'FS_TOO_LARGE') throw new Error(`Material budget exceeded at ${path}`, { cause: error });
      throw error;
    }
    if (!file) throw new Error(`Missing configured source: ${path}`);
    const bytes = Buffer.byteLength(file.content);
    total += bytes;
    if (bytes > config.maxSourceBytes || total > config.maxInputBytes) throw new Error(`Material budget exceeded at ${path}`);
    sources.push({ sourceId: path, path, role, content: file.content, version: file.version, writable,
      sensitivity: /<!--\s*sensitive\s*-->/i.test(file.content) ? 'sensitive' : 'private',
      protectedText: protectedText(file.content, role) });
  }
  return { schemaVersion: 1, snapshotId, scope: structuredClone(scope), capturedAt: now.toISOString(), sources };
}

/** This digest is consumed before generation to skip repeated paid model calls. */
export function inputFingerprint(snapshot: Snapshot) {
  const { scope } = snapshot;
  const sources = snapshot.sources.map(s => ({ sourceId: s.sourceId, path: s.path, role: s.role,
    content: s.content, writable: s.writable, sensitivity: s.sensitivity, protectedText: s.protectedText }));
  sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return createHash('sha256').update(JSON.stringify({ policyVersion: 1, scope: {
    scopeId: scope.scopeId, agentId: scope.agentId, sessionId: scope.sessionId, memoryRootId: scope.memoryRootId,
  }, sources })).digest('hex');
}

export function sourcePath(config: DreamConfig, source: Source) {
  return source.role === 'persona' ? config.personaPath! : join(config.memoryRoot, source.path);
}
