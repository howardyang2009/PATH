import type { PathApiClient, TemplateSummary } from "@path/client-core";
import { useCallback, useMemo } from "react";
import { useScanOnSave } from "./scan-on-save.js";
import type { SaveState } from "./session-reducer.js";

/**
 * The palette's **template list** (#577): one `GET /v0/templates` scan when the Designer loads, and one
 * more after each save that lands (`savePhase` becomes `saved`), so a new template shows (#580). The
 * list is thin (no bodies) and carries every entry's registry-relative validity, so the palette can
 * show a broken template unselectable instead of dropping it (ADR 0050 decision 4).
 *
 * A failed scan is its own phase, not an empty list: "no templates" and "could not list templates" read
 * differently to an author, and the palette must not claim the project has none when the read failed.
 */
export type TemplateListLoad =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; templates: readonly TemplateSummary[] };

export function useTemplateList(
  client: PathApiClient,
  savePhase: SaveState["phase"],
): TemplateListLoad {
  const listTemplates = useCallback(async () => (await client.listTemplates()).templates, [client]);
  const load = useScanOnSave(listTemplates, savePhase, RESCAN_ON);
  // Mapped once per scan result, so a consumer keyed on this object does not re-run every render.
  return useMemo(() => {
    if (load.phase === "ready") return { phase: "ready", templates: load.value };
    if (load.phase === "error") return { phase: "error", message: load.message };
    return load;
  }, [load]);
}

/** The save phases that change which templates exist. */
const RESCAN_ON: readonly SaveState["phase"][] = ["saved", "deleted", "saved-as-template"];
