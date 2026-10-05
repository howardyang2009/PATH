import { type RouteReply, replyError } from "../http-json.js";
import { templateSummary, templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates/:id` (server-api-v0.md §10.2): the parsed envelope. An invalid template still
 * returns `200 valid:false` with `error`/`body` so it can be repaired; unknown id → `404`.
 */
export function handleGetTemplate({ ctx, params: [id] }: ApiRequest<[string]>): RouteReply {
  const entry = templatesOf(ctx).find(id);
  if (entry === undefined) return replyError(404, "not found");

  const etag = entry.etag;
  const body = { ...templateSummary(entry), format: entry.format, body: entry.body, etag };
  return { status: 200, headers: { ETag: etag }, body };
}
