import { useCallback, useEffect, useRef, useState } from "react";
import type { PathApiClient, WorkflowSummary } from "@path/client-core";
import type { SaveState } from "./session-reducer.js";

/**
 * The Designer's **workflow discovery**: one `GET /v0/workflows` scan for the whole surface, plus the
 * two policies the four consumers used to spell for themselves — when to refresh, and what a failed
 * scan means.
 *
 * Those four each owned a load: the problems pass kept a path `Set` and re-read on every save-phase
 * change, the open-existing picker a summary list, the first-save dialog a directory list, and the
 * ref-target picker a filtered path list — with three different failure stances (keep-last, empty,
 * empty) and no shared freshness story. A scan that landed while a dialog was open, or a save that
 * wrote a file another surface had already listed, read differently in each. Here the App loads once
 * and hands the snapshot down; a dialog is a projection, not a second reader.
 *
 * `null` workflows and `[]` mean different things and both are needed: `null` is **not scanned yet**
 * (or every scan has failed), so the dangling-ref check is suppressed and a dialog says it is still
 * discovering; `[]` is **scanned, none exist**. Collapsing them would flag every saved ref dangling for
 * one frame, and make an empty project indistinguishable from a broken one.
 */
export type DiscoveryLoad =
  | { phase: "loading" }
  /** A scan failed. `workflows` is the last successful one, or `null` if none ever landed. */
  | { phase: "error"; message: string; workflows: readonly WorkflowSummary[] | null }
  | { phase: "ready"; workflows: readonly WorkflowSummary[] };

/** The discovered workflows a projection can read, or `null` when none has landed (loading or failed). */
export function discoveredWorkflows(load: DiscoveryLoad): readonly WorkflowSummary[] | null {
  return load.phase === "loading" ? null : load.workflows;
}

/**
 * Load discovery once, and re-scan whenever a save **lands** (`savePhase` becomes `saved`). A save is
 * what changes the answer — a create-new child's first save writes its file, so the parent's
 * dangling-ref marker must clear on the next scan — while the transient `saving` phase changes
 * nothing, so the old re-read-on-every-phase-change is one scan per save instead of three.
 *
 * A failed scan is **best-effort**: it keeps the last successful list rather than reading as "none
 * discovered", because a read blip must not empty every picker or flag every ref dangling (#388, #392).
 */
export function useWorkflowDiscovery(client: PathApiClient, savePhase: SaveState["phase"]): DiscoveryLoad {
  const [load, setLoad] = useState<DiscoveryLoad>({ phase: "loading" });
  // The last successful scan, kept across failures and read when composing an error state.
  const lastGood = useRef<readonly WorkflowSummary[] | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const scan = useCallback((): void => {
    client
      .listWorkflows()
      .then((response) => {
        if (!alive.current) return;
        lastGood.current = response.workflows;
        setLoad({ phase: "ready", workflows: response.workflows });
      })
      .catch((error: unknown) => {
        if (!alive.current) return;
        setLoad({ phase: "error", message: error instanceof Error ? error.message : String(error), workflows: lastGood.current });
      });
  }, [client]);

  // The first scan, and one after each save that lands.
  useEffect(() => {
    scan();
  }, [scan]);
  useEffect(() => {
    if (savePhase === "saved") scan();
  }, [savePhase, scan]);

  return load;
}
