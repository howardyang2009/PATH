import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveState } from "./session-reducer.js";

/**
 * A scan's load state. On failure the last successful value is kept beside the message, so a caller that
 * must not empty itself on a read blip can keep showing it.
 */
export type ScanLoad<T> =
  | { phase: "loading" }
  | { phase: "error"; message: string; lastGood: T | null }
  | { phase: "ready"; value: T };

/** Scan with `fetch` now and after each save phase in `rescanOn`; both should be stable (a new identity re-scans). */
export function useScanOnSave<T>(
  fetch: () => Promise<T>,
  savePhase: SaveState["phase"],
  rescanOn: readonly SaveState["phase"][],
): ScanLoad<T> {
  const [load, setLoad] = useState<ScanLoad<T>>({ phase: "loading" });
  const lastGood = useRef<T | null>(null);
  // Set on mount, not at init, so StrictMode's dev remount leaves it live.
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
