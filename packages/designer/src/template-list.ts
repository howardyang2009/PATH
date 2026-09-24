import { useEffect, useState } from "react";
import type { PathApiClient, TemplateSummary } from "@path/client-core";

/**
 * The palette's **template list** (#577): one `GET /v0/templates` scan when the Designer loads. The
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

export function useTemplateList(client: PathApiClient): TemplateListLoad {
  const [load, setLoad] = useState<TemplateListLoad>({ phase: "loading" });
  useEffect(() => {
    let alive = true;
    client
      .listTemplates()
      .then((response) => {
        if (alive) setLoad({ phase: "ready", templates: response.templates });
      })
      .catch((error: unknown) => {
        if (alive) setLoad({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, [client]);
  return load;
}
