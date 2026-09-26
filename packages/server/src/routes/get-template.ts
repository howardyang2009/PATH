import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import { templateSummary, templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates/:id` (server-api-v0.md §10.2): the parsed envelope. An invalid template still returns `200
 * valid:false` with `error`/`body` so it can be repaired; unknown id → `404`.
 */
export function handleGetTemplate({ res, ctx, params: [id] }: ApiRequest<[string]>): void {
  const entry = templatesOf(ctx).byId.get(id);
  if (entry === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const etag = strongEtag(entry.bytes);
  const body = { ...templateSummary(entry), format: entry.format, body: entry.body, etag };
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(body));
}
