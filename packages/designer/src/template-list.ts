import type { AuthoredRootSummary, PathApiClient, TemplateSummary } from "@path/client-core";
import type { Message } from "@path/i18n";
import { useCallback, useMemo } from "react";
import { useScanOnSave } from "./scan-on-save.js";
import type { SaveState } from "./session-reducer.js";

/** The palette's template list: one scan at load, one after each save that lands, and one per new
 * `rescanKey`. A failed scan is its own phase, not an empty list, so the palette never claims the
 * project has none (ADR 0050). */
export type TemplateListLoad =
  | { phase: "loading" }
  | { phase: "error"; message: Message }
  | {
      phase: "ready";
      templates: readonly TemplateSummary[];
      /** The writable template roots, the user's own first, each with its folders. */
      roots: readonly AuthoredRootSummary[];
      /** The largest file the requester may write, in bytes; `null` when unlimited. */
      maxFileBytes: number | null;
    };

/** The subfolders of the `origin` template root, relative to it; `[]` before a scan lands. */
export function templateFolders(load: TemplateListLoad, origin: "user" | "shared"): string[] {
  if (load.phase !== "ready") return [];
  return [...(load.roots.find((root) => root.origin === origin)?.folders ?? [])];
}

export function useTemplateList(
  client: PathApiClient,
  savePhase: SaveState["phase"],
  rescanKey = 0,
): TemplateListLoad {
  // A new `rescanKey` gives the read a new identity, which is what makes `useScanOnSave` re-scan.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rescanKey is the re-scan trigger.
  const listTemplates = useCallback(async () => {
    const { templates, roots, max_file_bytes } = await client.listTemplates();
    return { templates, roots, maxFileBytes: max_file_bytes };
  }, [client, rescanKey]);
  const load = useScanOnSave(listTemplates, savePhase, RESCAN_ON);
  // Mapped once per scan result, so a consumer keyed on this object does not re-run every render.
  return useMemo(() => {
    if (load.phase === "ready") return { phase: "ready", ...load.value };
    if (load.phase === "error") return { phase: "error", message: load.message };
    return load;
  }, [load]);
}

/** The save phases that change which templates exist. */
const RESCAN_ON: readonly SaveState["phase"][] = ["saved", "deleted", "saved-as-template"];
