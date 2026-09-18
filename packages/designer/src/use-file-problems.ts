import { useMemo } from "react";
import type { WorkflowFile } from "@path/schema";
import { discoveredWorkflows, type DiscoveryLoad } from "./discovery.js";
import { fileProblems, refLookupFor, type Problem } from "./problems.js";

/**
 * The active file's cross-node problem list (#388, #392), behind one seam. The App used to hand-wire a
 * four-step chain: a `client.listWorkflows()` effect keyed on the save phase, into a `knownPaths` state,
 * into `refLookupFor`, into `fileProblems`. That put a discovery I/O effect and a derivation of the file
 * side by side with the authoring state, and split the dangling-ref rule across the App and `problems.ts`.
 *
 * Discovery is now `discovery.ts`'s (one scan for the whole surface, refreshed when a save lands), so this
 * is a pure projection of it: the discovered paths are `null` until a scan lands, which suppresses the
 * dangling-`workflow`-ref check rather than flagging every saved ref for one frame.
 */
export function useFileProblems(
  file: WorkflowFile | null,
  filePath: string | undefined,
  discovery: DiscoveryLoad,
): Problem[] {
  // The discovered-workflow path set — the origin the dangling-`workflow`-ref check resolves against.
  // `null` until a scan lands (or when every scan has failed), which skips the check entirely.
  const knownPaths = useMemo(() => {
    const workflows = discoveredWorkflows(discovery);
    return workflows === null ? null : new Set(workflows.map((wf) => wf.relative_path));
  }, [discovery]);

  // The ref lookup for the file (its own path resolves a relative ref; the discovered set says which targets
  // exist). `undefined` for a from-scratch root or before discovery loads, which skips the dangling-ref check.
  const refLookup = useMemo(() => refLookupFor(filePath, knownPaths), [filePath, knownPaths]);
  // The whole-file cross-node pass, derived once for the two readers (the canvas markers/panel and the launch
  // button's warning count) so the two cannot disagree and the walk runs one time per render.
  return useMemo<Problem[]>(() => (file ? fileProblems(file, refLookup) : []), [file, refLookup]);
}
