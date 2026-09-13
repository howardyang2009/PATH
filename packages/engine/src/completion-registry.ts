import type { JsonValue } from "@path/schema";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface CompletionResult {
  output: JsonValue;
}

/**
 * The gate between a step that returned `{ status: "awaiting" }` and the external `complete` call
 * that resolves it. One registry per run tree: the engine suspends on a deferred when a step goes
 * `awaiting`, and the complete route resolves it with the validated output.
 *
 * Keyed by the step's own run id (minted by the emitter). Multiple `awaiting` steps coexist in
 * parallel and complete in any order.
 */
export class CompletionRegistry {
  private readonly pending = new Map<string, Deferred<CompletionResult>>();

  /** Register a step run as awaiting and return a promise that resolves when `complete` is called. */
  wait(stepRunId: string, signal?: AbortSignal): Promise<CompletionResult> {
    const deferred = createDeferred<CompletionResult>();
    this.pending.set(stepRunId, deferred);

    if (signal) {
      const onAbort = () => {
        if (this.pending.delete(stepRunId)) {
          deferred.reject(new Error("cancelled"));
        }
      };
      if (signal.aborted) {
        onAbort();
        return deferred.promise;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      // Detach the listener once the deferred settles. The `.catch` swallows this cleanup chain's
      // own rejection (a copy of the "cancelled" reject the caller already handles on `deferred.promise`),
      // so it never surfaces as an unhandled rejection.
      void deferred.promise.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => {});
    }

    return deferred.promise;
  }

  /** Resolve an awaiting step with a validated output. Returns false when no step has that id. */
  complete(stepRunId: string, result: CompletionResult): boolean {
    const deferred = this.pending.get(stepRunId);
    if (!deferred) return false;
    this.pending.delete(stepRunId);
    deferred.resolve(result);
    return true;
  }

  /** Whether a step run id is waiting for completion. */
  has(stepRunId: string): boolean {
    return this.pending.has(stepRunId);
  }

  /** The number of steps waiting for completion. */
  get size(): number {
    return this.pending.size;
  }
}
