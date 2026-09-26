import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import { discoverTemplates, shippedTemplateDir } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `GET /v0/templates/:id` (server-api-v0.md §10.2, ADR 0050 decision 5): read one template as a
 * **parsed envelope** — `{ id, name, kind, origin, read_only, format, description, body, valid, error,
 * etag }` — not raw bytes, because `name`/`origin`/`read_only` are server-derived and not in the file.
 * `etag` is the sha256 of the exact on-disk bytes, so it feeds the §10.4 `If-Match` precondition
 * unchanged. Ungated read. An **invalid** template still returns `200` with `valid: false`, its
 * `error`, and its `body`, so author-mode can open it to repair it; an unknown id is `404`.
 */
export function handleGetTemplate(res: ServerResponse, ctx: RunsRouteContext, id: string): void {
  const { byId } = discoverTemplates(resolve(ctx.project.dir), shippedTemplateDir(ctx), ctx.stepPlugins);
  const entry = byId.get(id);
  if (entry === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const etag = strongEtag(entry.bytes);
  const body = {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    origin: entry.origin,
    read_only: entry.readOnly,
    format: entry.format,
    description: entry.description,
    body: entry.body,
    valid: entry.valid,
    error: entry.error,
    etag,
  };
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(body));
}
