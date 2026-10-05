import type { PathApiClient, WorkflowRootSummary, WorkflowSummary } from "@path/client-core";
import { useCallback, useMemo } from "react";
import { useScanOnSave } from "./scan-on-save.js";
import type { SaveState } from "./session-reducer.js";

/** One landed discovery scan: the workflows, and the writable roots a new one may land in. */
export interface DiscoveryScan {
  workflows: readonly WorkflowSummary[];
  roots: readonly WorkflowRootSummary[];
}

/** The Designer's workflow discovery: one `GET /v0/workflows` scan for the whole surface. `null`
 * means **not scanned yet** (or every scan failed); `[]` means **scanned, none exist**. */
export type DiscoveryLoad =
  | { phase: "loading" }
  /** A scan failed. `scan` is the last successful one, or `null` if none ever landed. */
  | { phase: "error"; message: string; scan: DiscoveryScan | null }
  | { phase: "ready"; scan: DiscoveryScan };

function scanOf(load: DiscoveryLoad): DiscoveryScan | null {
  return load.phase === "loading" ? null : load.scan;
}

/** The discovered workflows, or `null` before a scan lands. Only rows the Server offers to `open`
 * are kept unless `withCopies`: the Open picker also shows the rows to copy (ADR 0086), since a
 * shipped file is never opened or ref'd in place. */
export function discoveredWorkflows(
  load: DiscoveryLoad,
  { withCopies = false }: { withCopies?: boolean } = {},
): readonly WorkflowSummary[] | null {
  const workflows = scanOf(load)?.workflows ?? null;
  if (workflows === null) return null;
  return withCopies ? workflows : workflows.filter((w) => w.action === "open");
}

/** The writable workflow roots' project paths, the user's own first; `[]` before a scan lands. */
export function discoveredRoots(load: DiscoveryLoad): readonly string[] {
  return (scanOf(load)?.roots ?? []).map((root) => root.relative_path);
}

/** The shared workflow root's project path, or `undefined` before a scan lands. */
export function discoveredSharedRoot(load: DiscoveryLoad): string | undefined {
  return scanOf(load)?.roots.find((root) => root.origin === "shared")?.relative_path;
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
  const listWorkflows = useCallback(async (): Promise<DiscoveryScan> => {
    const { workflows, roots } = await client.listWorkflows();
    return { workflows, roots };
  }, [client, rescanKey]);
  const load = useScanOnSave(listWorkflows, savePhase, RESCAN_ON);
  // Mapped once per scan result, so a consumer keyed on this object does not re-run every render.
  return useMemo(() => {
    if (load.phase === "ready") return { phase: "ready", scan: load.value };
    if (load.phase === "error")
      return { phase: "error", message: load.message, scan: load.lastGood };
    return load;
  }, [load]);
}

const RESCAN_ON: readonly SaveState["phase"][] = ["saved", "deleted"];
