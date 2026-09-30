import type { PathApiClient, WorkflowSummary } from "@path/client-core";
import { useCallback, useMemo } from "react";
import { useScanOnSave } from "./scan-on-save.js";
import type { SaveState } from "./session-reducer.js";

/** The Designer's workflow discovery: one `GET /v0/workflows` scan for the whole surface. `null`
 * means **not scanned yet** (or every scan failed); `[]` means **scanned, none exist**. */
export type DiscoveryLoad =
  | { phase: "loading" }
  /** A scan failed. `workflows` is the last successful one, or `null` if none ever landed. */
  | { phase: "error"; message: string; workflows: readonly WorkflowSummary[] | null }
  | { phase: "ready"; workflows: readonly WorkflowSummary[] };

/** The discovered workflows, or `null` before a scan lands. Shipped rows are left out unless
 * `withShipped`: only the Open picker shows them, to copy one (ADR 0086), since a shipped file is
 * never opened or ref'd in place. */
export function discoveredWorkflows(
  load: DiscoveryLoad,
  { withShipped = false }: { withShipped?: boolean } = {},
): readonly WorkflowSummary[] | null {
  if (load.phase === "loading" || load.workflows === null) return null;
  return withShipped ? load.workflows : load.workflows.filter((w) => w.origin !== "shipped");
}

/** Load discovery once, and re-scan when a save **lands** (`savePhase` becomes `saved`) or
 * `rescanKey` changes (a copy wrote files outside a save). A failed scan is best-effort: it keeps
 * the last successful list rather than reading as "none discovered". */
export function useWorkflowDiscovery(
  client: PathApiClient,
  savePhase: SaveState["phase"],
  rescanKey = 0,
): DiscoveryLoad {
  // A new `rescanKey` gives the read a new identity, which is what makes `useScanOnSave` re-scan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rescanKey is the re-scan trigger.
  const listWorkflows = useCallback(
    async () => (await client.listWorkflows()).workflows,
    [client, rescanKey],
  );
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
