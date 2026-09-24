import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { sendJson } from "../http-json.js";
import { discoverTemplates, type TemplateKind } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";
import { shippedTemplateDir } from "./template-common.js";

/**
 * `GET /v0/templates?kind=step|workflow` (server-api-v0.md §10.1, ADR 0050 decision 4): the thin list
 * of the shipped∪user union — one summary per entry, **no `body`**, mirroring workflow discovery (§6).
 * Ungated read (§2.1), fresh scan each call. `kind` is an **optional** filter; omitted, both kinds
 * list. Each row carries its registry-relative `valid`/`error`, so the palette greys out a template it
 * cannot insert without hiding it.
 */
export function handleGetTemplates(res: ServerResponse, ctx: RunsRouteContext, kindParam: string | null): void {
  const { entries } = discoverTemplates(resolve(ctx.project.dir), shippedTemplateDir(ctx), ctx.stepPlugins);

  const filter: TemplateKind | undefined =
    kindParam === "step" || kindParam === "workflow" ? kindParam : undefined;

  const templates = entries
    .filter((e) => filter === undefined || e.kind === filter)
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      kind: e.kind,
      origin: e.origin,
      read_only: e.readOnly,
      valid: e.valid,
      error: e.error,
    }));

  sendJson(res, 200, { templates });
}
