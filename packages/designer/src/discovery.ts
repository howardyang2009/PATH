import type { PathApiClient, WorkflowSummary } from "@path/client-core";
import { useCallback, useMemo } from "react";
import { useScanOnSave } from "./scan-on-save.js";
import type { SaveState } from "./session-reducer.js";

/** The Designer's workflow discovery: one `GET /v0/workflows` scan for the whole surface. `null` means
 * **not scanned yet** (or every scan failed); `[]` means **scanned, none exist**. */
export type DiscoveryLoad =
  | { phase: "loading" }
  /** A scan failed. `workflows` is the last successful one, or `null` if none ever landed. */
  | { phase: "error"; message: string; workflows: readonly WorkflowSummary[] | null }
  | { phase: "ready"; workflows: readonly WorkflowSummary[] };

export function discoveredWorkflows(load: DiscoveryLoad): readonly WorkflowSummary[] | null {
  return load.phase === "loading" ? null : load.workflows;
}

/** Load discovery once, and re-scan when a save **lands** (`savePhase` becomes `saved`). A failed scan is
 * best-effort: it keeps the last successful list rather than reading as "none discovered". */
export function useWorkflowDiscovery(
  client: PathApiClient,
  savePhase: SaveState["phase"],
): DiscoveryLoad {
  const listWorkflows = useCallback(async () => (await client.listWorkflows()).workflows, [client]);
  const load = useScanOnSave(listWorkflows, savePhase, RESCAN_ON);
  // Mapped once per scan result, so a consumer keyed on this object does not re-run every render.
  return useMemo(() => {
    if (load.phase === "ready") return { phase: "ready", workflows: load.value };
    if (load.phase === "error")
      return { phase: "error", message: load.message, workflows: load.lastGood };
    return load;
  }, [load]);
}

const RESCAN_ON: readonly SaveState["phase"][] = ["saved", "deleted"];
