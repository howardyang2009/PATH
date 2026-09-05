import { useEffect, useMemo, useState } from "react";
import type { PathApiClient } from "@path/client-core";
import type { WorkflowFile } from "@path/schema";
import { fileProblems, refLookupFor, type Problem } from "./problems.js";
import type { SaveState } from "./session-reducer.js";

/**
 * The active file's cross-node problem list (#388, #392), gathered out of `App` into one module. The App
 * used to hand-wire a four-step chain: a `client.listWorkflows()` effect keyed on the save phase, into a
 * `knownPaths` state, into `refLookupFor`, into `fileProblems`. That put a discovery I/O effect and a
 * derivation of the file side by side with the authoring state, and split the dangling-ref rule across the
 * App and `problems.ts`. Here the chain is behind one seam: the App asks for the file's problems and reads
 * them; the discovery mechanics do not leak up.
 *
 * Discovery re-reads on `savePhase` so a create-new child's first save writes its file and the parent's
 * dangling-ref marker clears on the next `saved`. It is best-effort — a failed scan keeps the last set, so a
 * ref is not flagged dangling on a read blip — and `knownPaths` starts `null` (not an empty set), so the
 * dangling-ref check is suppressed until the first scan lands rather than flagging every saved ref for one
 * frame.
 */
export function useFileProblems(
  client: PathApiClient,
  file: WorkflowFile | null,
  filePath: string | undefined,
  savePhase: SaveState["phase"],
): Problem[] {
  // The discovered-workflow path set — the origin the dangling-`workflow`-ref check resolves against. `null`
  // until the first scan lands. A fresh scan on mount and after every save transition.
  const [knownPaths, setKnownPaths] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    client
      .listWorkflows()
      .then((discovered) => {
        if (!cancelled) setKnownPaths(new Set(discovered.workflows.map((wf) => wf.relative_path)));
      })
      .catch(() => {
        // Best-effort; keep the last known set rather than flag every ref dangling on a read blip.
      });
    return () => {
      cancelled = true;
    };
  }, [client, savePhase]);

  // The ref lookup for the file (its own path resolves a relative ref; the discovered set says which targets
  // exist). `undefined` for a from-scratch root or before discovery loads, which skips the dangling-ref check.
  const refLookup = useMemo(() => refLookupFor(filePath, knownPaths), [filePath, knownPaths]);
  // The whole-file cross-node pass, derived once for the two readers (the canvas markers/panel and the launch
  // button's warning count) so the two cannot disagree and the walk runs one time per render.
  return useMemo<Problem[]>(() => (file ? fileProblems(file, refLookup) : []), [file, refLookup]);
}
