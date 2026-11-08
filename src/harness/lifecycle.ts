export type CleanupAction = () => unknown | PromiseLike<unknown>;

/** Start every cleanup in declaration order, containing synchronous throws as
 * well as rejected promises. Settlement means every started action has drained;
 * failures are reported together only then. The cached promise is installed
 * before calling any action, so reentrant/repeated disposal never starts twice.
 * No timeout can turn an uncooperative action into an apparently finished one. */
export function createSettledCleanup(actions: readonly CleanupAction[], message = 'Dream lifecycle cleanup failed'): () => Promise<void> {
  const steps = [...actions];
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const started = steps.map(action => {
      try { return Promise.resolve(action()); }
      catch (error) { return Promise.reject(error); }
    });
    void Promise.allSettled(started).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) reject(new AggregateError(errors, message));
      else resolve();
    });
    return pending;
  };
}
