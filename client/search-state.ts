/** Latest-only asynchronous list search. The pending state begins before the
 * debounce so an empty previous result is never presented as the new answer. */
export type SearchPhase = 'idle' | 'loading' | 'success' | 'error';
export interface SearchState<Item> {
  phase: SearchPhase;
  query: string;
  items: Item[];
  truncated: boolean;
  error: string | null;
}
export interface SearchClock {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
export const idleSearch = <Item>(): SearchState<Item> => ({ phase: 'idle', query: '', items: [], truncated: false, error: null });
export function searchStatus(phase: SearchPhase): 'searchPrompt' | 'searchLoading' | 'searchFailed' | null {
  return phase === 'idle' ? 'searchPrompt' : phase === 'loading' ? 'searchLoading' : phase === 'error' ? 'searchFailed' : null;
}
export function localOptionMatches(option: { value: string; label: string; description?: string } | undefined, query: string): boolean {
  if (!option) return false;
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
  return normalize([option.label, option.value, option.description ?? ''].join(' ')).includes(normalize(query.trim()));
}

export function createLatestSearch<Item>({ request, publish, describeError, delayMs = 200,
  clock = { schedule: (callback, delay) => setTimeout(callback, delay), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
}: {
  request(query: string, signal: AbortSignal): Promise<{ items: Item[]; truncated: boolean }>;
  publish(state: SearchState<Item>): void;
  describeError(error: unknown): string;
  delayMs?: number;
  clock?: SearchClock;
}) {
  let revision = 0;
  let pending: unknown;
  let controller: AbortController | undefined;
  let disposed = false;
  const clear = () => {
    if (pending !== undefined) { clock.cancel(pending); pending = undefined; }
    controller?.abort(); controller = undefined;
  };
  return {
    search(query = '') {
      if (disposed) return;
      const expected = ++revision;
      clear();
      publish({ phase: 'loading', query, items: [], truncated: false, error: null });
      pending = clock.schedule(() => {
        pending = undefined;
        const active = new AbortController(); controller = active;
        void (async () => {
          try {
            const result = await request(query, active.signal);
            if (!disposed && expected === revision && !active.signal.aborted) publish({ phase: 'success', query, items: result.items, truncated: result.truncated, error: null });
          } catch (error) {
            if (!disposed && expected === revision && !active.signal.aborted) publish({ phase: 'error', query, items: [], truncated: false, error: describeError(error) });
          }
        })();
      }, delayMs);
    },
    cancel() {
      revision++; clear();
      if (!disposed) publish(idleSearch<Item>());
    },
    dispose() { disposed = true; revision++; clear(); },
  };
}
