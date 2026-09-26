import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveState } from "./session-reducer.js";

/**
 * A **scan that follows saves**: one read when the Designer loads, and one more each time a save phase
 * named in `rescanOn` lands — because a save is what changes the answer (a new file, a new template),
 * while the transient `saving` phase changes nothing.
 *
 * Two lists read this way — workflow discovery and the palette's template list — and each spelled the
 * scan, the liveness flag and the rescan trigger for itself, with two different liveness rules. The
 * rule lives here once: the flag is set on mount (not only at initialisation), which stays correct
 * however many times React mounts the component.
 *
 * A failed scan keeps the last successful value beside the message, so a caller that must not empty
 * itself on a read blip can keep showing it (discovery does; the template list shows the failure).
 */
export type ScanLoad<T> =
  | { phase: "loading" }
  | { phase: "error"; message: string; lastGood: T | null }
  | { phase: "ready"; value: T };

/**
 * Scan with `fetch` now and after each save phase in `rescanOn`. `fetch` and `rescanOn` should be
 * stable (memoised, or module constants): a new identity re-scans.
 */
export function useScanOnSave<T>(
  fetch: () => Promise<T>,
  savePhase: SaveState["phase"],
  rescanOn: readonly SaveState["phase"][],
): ScanLoad<T> {
  const [load, setLoad] = useState<ScanLoad<T>>({ phase: "loading" });
  const lastGood = useRef<T | null>(null);
  // Set on mount (not only at init), so StrictMode's dev mount-unmount-mount leaves it live.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const scan = useCallback((): void => {
    fetch()
      .then((value) => {
        if (!alive.current) return;
        lastGood.current = value;
        setLoad({ phase: "ready", value });
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        setLoad({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
          lastGood: lastGood.current,
        });
      });
  }, [fetch]);

  useEffect(() => {
    scan();
  }, [scan]);
  useEffect(() => {
    if (rescanOn.includes(savePhase)) scan();
  }, [savePhase, rescanOn, scan]);

  return load;
}
