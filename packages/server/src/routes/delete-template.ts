import { type RouteReply, replyError } from "../http-json.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/** `DELETE /v0/templates/:id` (server-api-v0.md §10.5): remove a user template; shipped → `403`,
 * unknown → `404`. */
export function handleDeleteTemplate({ ctx, params: [id] }: ApiRequest<[string]>): RouteReply {
  const removed = templatesOf(ctx).remove(id);
  if (!removed.ok) return replyError(removed.status, removed.message);

  return { status: 204 };
}
