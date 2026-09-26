import { unlinkSync } from "node:fs";
import { sendError } from "../http-json.js";
import { templatesOf, writableTemplate } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `DELETE /v0/templates/:id` (server-api-v0.md §10.5, ADR 0050 decision 9): remove a user template.
 * Origin-gated centrally. `204` on success; a **shipped** id is a `403`; an unknown id is a `404`
 * (delete-missing reports not-found, not an idempotent `204`, matching the by-id lookup stance).
 */
export function handleDeleteTemplate({ res, ctx, params: [id] }: ApiRequest<[string]>): void {
  const found = writableTemplate(templatesOf(ctx), id);
  if (!found.ok) {
    sendError(res, found.status, found.message);
    return;
  }

  unlinkSync(found.entry.absPath);
  res.writeHead(204);
  res.end();
}
