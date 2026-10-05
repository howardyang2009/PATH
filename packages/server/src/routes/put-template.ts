import type { WireTemplateWriteResponse } from "@path/schema";
import { type RouteReply, readJsonBody, replyError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `PUT /v0/templates/:id` (server-api-v0.md §10.4, ADR 0050 decision 7): **update-only** and
 * **precondition-gated**. The request body is the full template object; its `id` must equal `:id`.
 * Origin-gated centrally. Unlike `PUT /v0/workflows` it is not an upsert — an unknown id is a
 * `404`, not a create (creation is §10.3). It **cannot rename**: the write lands on the resolved
 * entry's own file, so the file stem (hence `name`) is immutable through this door. A shipped id is
 * a `403`. The server serializes the raw request object (author key order preserved), as
 * `put-workflow` does.
 */
export async function handlePutTemplate({
  req,
  ctx,
  params: [id],
}: ApiRequest<[string]>): Promise<RouteReply> {
  const raw = await readJsonBody(req);
  if (!raw.ok) return replyError(400, "request body must be valid JSON");

  // Precondition (ADR 0016): `If-Match` carrying the §10.2 etag is required, and absent or stale is
  // a `412`. The store's one call resolves, validates, decides and writes, so the check has no
  // suspension point before it and only an *external* writer can invalidate the token.
  const written = templatesOf(ctx).update(id, raw.value, firstHeader(req.headers["if-match"]));
  if (!written.ok) {
    return replyError(
      written.status,
      written.message,
      "details" in written ? written.details : undefined,
    );
  }
  const reply: WireTemplateWriteResponse = {
    id,
    relative_path: written.relativePath,
    etag: written.etag,
  };
  return { status: 200, headers: { ETag: written.etag }, body: reply };
}
