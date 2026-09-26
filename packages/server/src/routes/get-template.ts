import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import { templateSummary, templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates/:id` (server-api-v0.md §10.2, ADR 0050 decision 5): read one template as a
 * **parsed envelope** — `{ id, name, kind, origin, read_only, format, description, body, valid, error,
 * etag }` — not raw bytes, because `name`/`origin`/`read_only` are server-derived and not in the file.
 * `etag` is the sha256 of the exact on-disk bytes, so it feeds the §10.4 `If-Match` precondition
 * unchanged. Ungated read. An **invalid** template still returns `200` with `valid: false`, its
 * `error`, and its `body`, so author-mode can open it to repair it; an unknown id is `404`.
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
