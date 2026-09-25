import { useCallback, useEffect, useRef, useState } from "react";
import type { PathApiClient, TemplateSummary } from "@path/client-core";
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

export function useTemplateList(client: PathApiClient, savePhase: SaveState["phase"]): TemplateListLoad {
  const [load, setLoad] = useState<TemplateListLoad>({ phase: "loading" });
  // Set on mount (not only at init), so StrictMode's dev mount-unmount-mount leaves it live.
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const scan = useCallback((): void => {
    client
      .listTemplates()
      .then((response) => {
        if (alive.current) setLoad({ phase: "ready", templates: response.templates });
      })
      .catch((error: unknown) => {
        if (alive.current) setLoad({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      });
  }, [client]);

  // The first scan, and one after each save or delete that lands.
  useEffect(() => {
    scan();
  }, [scan]);
  useEffect(() => {
    if (savePhase === "saved" || savePhase === "deleted") scan();
  }, [savePhase, scan]);

  return load;
}
