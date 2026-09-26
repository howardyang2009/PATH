import type { ServerResponse } from "node:http";
import { sendJson } from "../http-json.js";
import { templateSummary, templatesOf, type TemplateKind } from "../template-store.js";
import type { RouteContext } from "./route-context.js";

/**
 * `GET /v0/templates?kind=step` (server-api-v0.md §10.1, ADR 0050 decision 4): the thin list
 * of the shipped∪user union — one summary per entry, **no `body`**, mirroring workflow discovery (§6).
 * Ungated read (§2.1), fresh scan each call. `kind` is an **optional** filter; `step` is the only kind
 * (ADR 0063), so it changes nothing today. Each row carries its registry-relative `valid`/`error`, so the palette greys out a template it
 * cannot insert without hiding it.
 */
export function handleGetTemplates(res: ServerResponse, ctx: RouteContext, kindParam: string | null): void {
  const { entries } = templatesOf(ctx);

  const filter: TemplateKind | undefined =
    kindParam === "step" ? kindParam : undefined;

  const templates = entries.filter((e) => filter === undefined || e.kind === filter).map(templateSummary);

  sendJson(res, 200, { templates });
}
