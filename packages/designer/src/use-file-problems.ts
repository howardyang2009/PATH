import type { WorkflowFile } from "@path/schema";
import { useMemo } from "react";
import { type DiscoveryLoad, discoveredWorkflows } from "./discovery.js";
import { fileProblems, type Problem, refLookupFor } from "./problems.js";

/** The active file's cross-node problem list, a pure projection of `discovery.ts`'s scan. `knownPaths` is
 * `null` until a scan lands, which suppresses the dangling-`workflow`-ref check rather than flagging refs. */
export function useFileProblems(
  file: WorkflowFile | null,
  filePath: string | undefined,
  discovery: DiscoveryLoad,
): Problem[] {
  const knownPaths = useMemo(() => {
    const workflows = discoveredWorkflows(discovery);
    return workflows === null ? null : new Set(workflows.map((wf) => wf.relative_path));
  }, [discovery]);

  const refLookup = useMemo(() => refLookupFor(filePath, knownPaths), [filePath, knownPaths]);
  // Derived once for both readers (the canvas markers and the launch warning count), so the two cannot disagree.
  return useMemo<Problem[]>(() => (file ? fileProblems(file, refLookup) : []), [file, refLookup]);
}
