export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

/**
 * A settle-once deferred: `POST /v0/runs` needs to resolve as soon as `runWorkflow`'s
 * `runStarted` hook fires — well before the run itself finishes — but must not hang forever if
 * the run never reaches that hook (a bug thrown earlier in `runWorkflow`). Guarding both
 * `resolve`/`reject` behind one `settled` flag lets both the observer hook and the run's own
 * promise race to settle this without either clobbering the other.
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
