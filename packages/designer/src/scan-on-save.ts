import { type Load, useResource } from "@path/viewer/use-resource";
import { useRef } from "react";
import type { SaveState } from "./session-reducer.js";

/**
 * A scan's load state: the Viewer's one load lifecycle, which keeps the last successful value on
 * the `error` phase so a caller that must not empty itself on a read blip can keep showing it.
 */
export type ScanLoad<T> = Load<T>;

/** Scan with `fetch` now and after each save phase in `rescanOn`; both should be stable (a new
 * identity re-scans). The re-scans keep the last value on screen rather than flashing `loading`.
 */
export function useScanOnSave<T>(
  fetch: () => Promise<T>,
  savePhase: SaveState["phase"],
  rescanOn: readonly SaveState["phase"][],
): ScanLoad<T> {
  // The count of save phases that ask for a re-scan. It rides `useResource`'s deps, so a phase
  // change the caller did not name starts no read.
  const tick = useRef(0);
  const previous = useRef(savePhase);
  if (previous.current !== savePhase) {
    previous.current = savePhase;
    if (rescanOn.includes(savePhase)) tick.current += 1;
  }
  return useResource(fetch, [tick.current], {
    keepLastGood: true,
    manual: true,
  }).load;
}
