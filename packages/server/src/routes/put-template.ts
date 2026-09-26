import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, resolve } from "node:path";
import { makeStepTemplateSchema, safeParseStepTemplateWith, type WireTemplateWriteResponse } from "@path/schema";
import { checkPrecondition, writeArtifact } from "../artifact-file.js";
import { readJsonBody, sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { discoverTemplates, shippedTemplateDir } from "../template-store.js";
import type { RouteContext } from "./route-context.js";

/**
 * `PUT /v0/templates/:id` (server-api-v0.md §10.4, ADR 0050 decision 7): **update-only** and
 * **precondition-gated**. The request body is the full template object; its `id` must equal `:id`.
 * Origin-gated centrally. Unlike `PUT /v0/workflows` it is not an upsert — an unknown id is a `404`,
 * not a create (creation is §10.3). It **cannot rename**: the write lands on the resolved entry's own
 * `absPath`, so the file stem (hence `name`) is immutable through this door. A shipped id is a `403`.
 * The server serializes the raw request object (author key order preserved), as `put-workflow` does.
 */
export async function handlePutTemplate(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  id: string,
): Promise<void> {
  const raw = await readJsonBody(req);
  if (!raw.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }

  const projectDir = resolve(ctx.project.dir);
  const { byId } = discoverTemplates(projectDir, shippedTemplateDir(ctx), ctx.stepPlugins);
  const entry = byId.get(id);
  if (entry === undefined) {
    sendError(res, 404, "not found");
    return;
  }
  if (entry.readOnly) {
    sendError(res, 403, "template is read-only");
    return;
  }

  // Precondition (ADR 0016): `If-Match` carrying the §10.2 etag is required. Absent or stale is a
  // `412`. The etag check through the write below is a single synchronous block — no `await` between
  // them — so only an *external* writer can invalidate the token, which is what it guards.
  const precondition = checkPrecondition(entry.bytes, firstHeader(req.headers["if-match"]), "overwrite");
  if (!precondition.ok) {
    sendError(res, 412, precondition.conflict === "required" ? "precondition failed: If-Match required" : "precondition failed: the template changed since it was read");
    return;
  }

  const rawBody = raw.value as Record<string, unknown>;
  if (rawBody.id !== id) {
    sendError(res, 400, "template id in body must match the URL id");
    return;
  }

  const validation = safeParseStepTemplateWith(makeStepTemplateSchema(ctx.stepPlugins), rawBody);
  if (!validation.success) {
    sendError(res, 400, "template validation failed", validation.errors);
    return;
  }

  const { etag } = writeArtifact(entry.absPath, rawBody, { create: false });
  const reply: WireTemplateWriteResponse = { id, relative_path: relative(projectDir, entry.absPath), etag };
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
