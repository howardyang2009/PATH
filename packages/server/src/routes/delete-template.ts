import { unlinkSync } from "node:fs";
import { sendError } from "../http-json.js";
import { templatesOf, writableTemplate } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/** `DELETE /v0/templates/:id` (server-api-v0.md §10.5): remove a user template; shipped → `403`, unknown → `404`. */
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
