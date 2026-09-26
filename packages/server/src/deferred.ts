export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

/**
 * A settle-once deferred: `POST /v0/runs` resolves as soon as `runWorkflow`'s `runStarted` hook fires,
 * well before the run finishes, but must not hang if the run never reaches it (a bug thrown earlier).
 * One `settled` flag lets the observer hook and the run's own promise race without clobbering.
 */
export function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolveFn(value);
    },
    reject(err) {
      if (settled) return;
      settled = true;
      rejectFn(err);
    },
  };
}
