import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

// The `Load` vocabulary travels with the hook, so a consumer of the `use-resource` subpath need not
// also pull the Viewer's barrel.
export type { Load } from "./load-state.js";

/**
 * The one load lifecycle the read panes share: run a read when its dependencies change, drop a
 * landing the pane has outrun, and expose the three-phase {@link Load}. `refetch` re-reads on
 * demand; `pollMs` re-reads on an interval with the loading phase shown only for the first read.
 *
 * A **read may return its value directly** (a pure "there is nothing to fetch" answer), which lands
 * as `ready` without a round-trip. A stream subscription is not a load: `use-run-view` owns its own
 * teardown.
 */

export interface ResourceOptions {
  /** Re-read at this interval; the first read's `loading` phase is not re-shown. */
  pollMs?: number;
  /** `false` runs no read at all — a scope with nothing open reads nothing. */
  enabled?: boolean;
  /** Carry the last value that landed on the `error` phase, for a host that must keep showing its
   * stale list rather than empty itself on a read blip. */
  keepLastGood?: boolean;
  /** Expose `refetch` for a read driven on demand rather than by `deps`; the initial read still
   * runs. */
  manual?: boolean;
}

export interface Resource<T> {
  load: Load<T>;
  /** Read again in place, keeping the current value until the new one lands. */
  refetch: () => void;
}

export function useResource<T>(
  read: () => Promise<T> | T,
  deps: readonly unknown[] = [],
  options: ResourceOptions = {},
): Resource<T> {
  const [load, setLoad] = useState<Load<T>>({ phase: "loading" });
  // The latest read, so a poll or a refetch calls the closure of the current render rather than the
  // one the effect started with.
  const readRef = useRef(read);
  readRef.current = read;
  // Read through a ref so `run` keeps its identity: a changing option object must not restart a
  // read.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // A landing is dropped when a newer run has started: the counter is bumped by every run.
  const runRef = useRef(0);
  // The last value that landed, for `keepLastGood`.
  const lastGoodRef = useRef<T | undefined>(undefined);
  const [refetchNonce, setRefetchNonce] = useState(0);
  const fail = useCallback((error: unknown): void => {
    setLoad({
      phase: "error",
      message: errorMessage(error),
      ...(optionsRef.current.keepLastGood === true ? { lastGood: lastGoodRef.current } : {}),
    });
  }, []);

  const run = useCallback(
    (showLoading: boolean): void => {
      runRef.current += 1;
      const generation = runRef.current;
      // A `manual` read keeps its value while a `refetch` is in flight; only its first read shows
      // `loading`. A `deps`-driven read shows it on every input change, as it always has.
      if (showLoading && !(optionsRef.current.manual === true && runRef.current > 1)) {
        setLoad({ phase: "loading" });
      }
      let result: Promise<T> | T;
      try {
        result = readRef.current();
      } catch (error: unknown) {
        fail(error);
        return;
      }
      if (!(result instanceof Promise)) {
        lastGoodRef.current = result;
        setLoad({ phase: "ready", value: result });
        return;
      }
      result
        .then((value) => {
          if (generation !== runRef.current) return;
          lastGoodRef.current = value;
          setLoad({ phase: "ready", value });
        })
        .catch((error: unknown) => {
          if (generation === runRef.current) fail(error);
        });
    },
    [fail],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's deps are the read's inputs.
  useEffect(() => {
    if (options.enabled === false) return;
    run(true);
    if (options.pollMs === undefined) return;
    const timer = setInterval(() => run(false), options.pollMs);
    return () => clearInterval(timer);
  }, [readRef, run, options.pollMs, options.enabled, refetchNonce, ...deps]);

  const refetch = useCallback((): void => setRefetchNonce((nonce) => nonce + 1), []);

  return { load, refetch };
}
