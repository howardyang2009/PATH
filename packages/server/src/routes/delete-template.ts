import { sendError } from "../http-json.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/** `DELETE /v0/templates/:id` (server-api-v0.md §10.5): remove a user template; shipped → `403`,
 * unknown → `404`. */
export function handleDeleteTemplate({ res, ctx, params: [id] }: ApiRequest<[string]>): void {
  const removed = templatesOf(ctx).remove(id);
  if (!removed.ok) {
    sendError(res, removed.status, removed.message);
    return;
  }

  res.writeHead(204);
  res.end();
}
