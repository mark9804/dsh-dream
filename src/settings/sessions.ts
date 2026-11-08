import { SettingsFailure } from './contracts.js';
import { isDreamVerificationSession } from './session-fixtures.js';

export interface SessionHeaderMetadata {
  readonly id: string; readonly version?: number; readonly createdAt?: number; readonly cwd?: string;
  readonly isSeeded?: boolean; readonly parentSession?: string; readonly origin?: 'subagent'; readonly delegationDepth?: number;
}
export interface SessionDirectoryRecord { header: SessionHeaderMetadata; live: boolean; persisted: boolean }
interface DirectoryProjection { values: { title?: string | null; sessionListMetadata?: { blank?: boolean; lastPromptAt?: number | null } } }
const DIRECTORY_PROJECTIONS = ['title', 'sessionListMetadata'] as const;
interface DirectoryContext {
  get(name: string): unknown;
}
export interface SessionDirectoryItem { id: string; title: string; cwd?: string; live: boolean }
const MAIN_LIST_TTL_MS = 2000;

/** A fork made for the user is still a main conversation. Parent lineage alone
 * is not a subagent marker; durable origin/delegation metadata is authoritative. */
export function isMainConversation(header: SessionHeaderMetadata): boolean {
  return header.origin !== 'subagent' && !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0) && !isDreamVerificationSession(header);
}

/** Headers are shared briefly across a typing burst. Titles come from the Host's
 * live incremental fold or lifecycle-checked persisted projection cache: listing
 * never replays cold conversations or searches their message contents. */
export function createSettingsSessionDirectory(ctx: DirectoryContext, now: () => number = Date.now) {
  let cache: { records: SessionDirectoryRecord[]; at: number; source: unknown } | undefined;
  let inFlight: { source: unknown; generation: number; promise: Promise<SessionDirectoryRecord[]> } | undefined;
  let disposed = false;
  let generation = 0;
  const running = new Set<Promise<SessionDirectoryRecord[]>>();
  const resolving = new Set<Promise<SessionDirectoryItem[]>>();
  const stop = new AbortController();
  const original = (value: unknown) => value && typeof value === 'object' ? (value as Record<symbol, unknown>)[Symbol.for('cordis.original')] ?? value : value;

  async function records(signal?: AbortSignal): Promise<SessionDirectoryRecord[]> {
    signal?.throwIfAborted();
    if (disposed) throw new SettingsFailure('UNAVAILABLE', 'Session directory has been disposed');
    const service = ctx.get('sessionQuery') as { listSessions(signal?: AbortSignal): Promise<SessionDirectoryRecord[]> } | undefined;
    if (!service) throw new SettingsFailure('UNAVAILABLE', 'Session metadata service is unavailable');
    const source = original(service);
    if (cache && cache.source === source && now() - cache.at < MAIN_LIST_TTL_MS) return cache.records;
    if (!inFlight || inFlight.source !== source || inFlight.generation !== generation) {
      const expectedGeneration = generation;
      const pending = { source, generation: expectedGeneration, promise: Promise.resolve().then(() => service.listSessions(stop.signal)).then(rows => {
        stop.signal.throwIfAborted();
        const main = rows.filter(row => isMainConversation(row.header)).map(row => ({ ...row, header: { ...row.header } }));
        if (generation === expectedGeneration && original(ctx.get('sessionQuery')) === source) cache = { records: main, at: now(), source };
        return main;
      }) };
      inFlight = pending; running.add(pending.promise);
      void pending.promise.then(() => { running.delete(pending.promise); if (inFlight === pending) inFlight = undefined; }, () => { running.delete(pending.promise); if (inFlight === pending) inFlight = undefined; });
    }
    const pending = inFlight.promise;
    // One superseded browser query must not cancel a newer query sharing headers.
    // Each caller still detaches immediately on abort; owner disposal cancels I/O.
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  async function search(query: string, signal?: AbortSignal): Promise<{ items: SessionDirectoryItem[]; truncated: boolean }> {
    signal?.throwIfAborted();
    const rows = await records(signal); signal?.throwIfAborted();
    const live = ctx.get('sessions') as { get(id: string): unknown } | undefined;
    const liveProjections = ctx.get('sessionProjections') as { snapshot(session: unknown, keys: readonly string[]): DirectoryProjection } | undefined;
    const projections = ctx.get('sessionProjectionCache') as { cachedSnapshot(header: SessionHeaderMetadata, keys: readonly string[]): DirectoryProjection | undefined; cachedPredecessorTitle?(header: SessionHeaderMetadata): DirectoryProjection | undefined } | undefined;
    const needle = query.trim().normalize('NFKC').toLocaleLowerCase();
    const items: SessionDirectoryItem[] = [];
    let matched = 0;
    for (const row of rows) {
      signal?.throwIfAborted();
      const session = live?.get(row.header.id);
      const attached = session !== undefined ? liveProjections?.snapshot(session, DIRECTORY_PROJECTIONS) : undefined;
      if (attached?.values.sessionListMetadata?.blank === true) continue;
      const stored = !attached?.values.title ? projections?.cachedSnapshot(row.header, DIRECTORY_PROJECTIONS) : undefined;
      // A live Session supersedes every cached hint, including missing metadata.
      // Unknown/non-boolean is not proof of blankness; no cold log is replayed.
      const metadata = session !== undefined ? attached?.values.sessionListMetadata : stored?.values.sessionListMetadata;
      if (metadata?.blank === true) continue;
      const title = attached?.values.title || stored?.values.title
        || projections?.cachedPredecessorTitle?.(row.header)?.values.title || row.header.id;
      if (needle && !`${title}\n${row.header.id}\n${row.header.cwd ?? ''}`.normalize('NFKC').toLocaleLowerCase().includes(needle)) continue;
      matched++;
      if (items.length < 100) items.push({ id: row.header.id, title, ...(row.header.cwd ? { cwd: row.header.cwd } : {}), live: session !== undefined || row.live });
    }
    return { items, truncated: matched > items.length };
  }
  async function resolveSelected(ids: readonly string[], signal?: AbortSignal): Promise<SessionDirectoryItem[]> {
    const lifetime = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    lifetime.throwIfAborted();
    const live = ctx.get('sessions') as { get(id: string): { header: SessionHeaderMetadata } | undefined } | undefined;
    const fold = ctx.get('sessionProjections') as { snapshot(session: unknown, keys: readonly string[]): DirectoryProjection } | undefined;
    const persisted = ctx.get('sessionPersistence') as { stat(id: string, options: { signal: AbortSignal }): Promise<{ header: SessionHeaderMetadata } | undefined> } | undefined;
    const titles = ctx.get('sessionProjectionCache') as { cachedSnapshot(header: SessionHeaderMetadata, keys: readonly string[]): DirectoryProjection | undefined; cachedPredecessorTitle?(header: SessionHeaderMetadata): DirectoryProjection | undefined } | undefined;
    const result: SessionDirectoryItem[] = [];
    for (const id of [...new Set(ids)].slice(0, 17)) {
      lifetime.throwIfAborted();
      let session = live?.get(id);
      const header = session?.header ?? (await persisted?.stat(id, { signal: lifetime }))?.header;
      lifetime.throwIfAborted();
      // A Session may have become live during stat; its projection wins.
      session = live?.get(id) ?? session;
      const current = session?.header ?? header;
      if (current && current.id !== id) throw new SettingsFailure('UNAVAILABLE', 'Saved session metadata identity mismatch');
      const title = (session ? fold?.snapshot(session, ['title']).values.title : undefined)
        || (current ? titles?.cachedSnapshot(current, ['title'])?.values.title || titles?.cachedPredecessorTitle?.(current)?.values.title : undefined) || id;
      result.push({ id, title, ...(current?.cwd ? { cwd: current.cwd } : {}), live: session !== undefined });
    }
    return result;
  }
  return { search, resolveSelected(ids: readonly string[], signal?: AbortSignal) {
    const work = resolveSelected(ids, signal); resolving.add(work);
    void work.then(() => resolving.delete(work), () => resolving.delete(work));
    return work;
  }, invalidate() { generation++; cache = undefined; }, async dispose() {
    if (disposed) return; disposed = true; generation++; cache = undefined; stop.abort(new Error('Session directory owner disposed'));
    await Promise.allSettled([...running, ...resolving]);
  } };
}
