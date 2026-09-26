import { unlinkSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { sendError } from "../http-json.js";
import { discoverTemplates, shippedTemplateDir } from "../template-store.js";
import type { RouteContext } from "./route-context.js";

/**
 * `DELETE /v0/templates/:id` (server-api-v0.md §10.5, ADR 0050 decision 9): remove a user template.
 * Origin-gated centrally. `204` on success; a **shipped** id is a `403`; an unknown id is a `404`
 * (delete-missing reports not-found, not an idempotent `204`, matching the by-id lookup stance).
 */
export function handleDeleteTemplate(res: ServerResponse, ctx: RouteContext, id: string): void {
  const { byId } = discoverTemplates(resolve(ctx.project.dir), shippedTemplateDir(ctx), ctx.stepPlugins);
  const entry = byId.get(id);
  if (entry === undefined) {
    sendError(res, 404, "not found");
    return;
  }
  if (entry.readOnly) {
    sendError(res, 403, "template is read-only");
    return;
  }

  unlinkSync(entry.absPath);
  res.writeHead(204);
  res.end();
}
