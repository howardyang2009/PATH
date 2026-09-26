import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, resolve } from "node:path";
import {
  makeStepTemplateSchema,
  safeParseStepTemplateWith,
  type WireTemplateWriteResponse,
} from "@path/schema";
import { checkPrecondition, PRECONDITION_FAILED, writeArtifact } from "../artifact-file.js";
import { readJsonBody, sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { templatesOf, writableTemplate } from "../template-store.js";
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

  const found = writableTemplate(templatesOf(ctx), id);
  if (!found.ok) {
    sendError(res, found.status, found.message);
    return;
  }
  const { entry } = found;

  // Precondition (ADR 0016): `If-Match` carrying the §10.2 etag is required. Absent or stale is a
  // `412`. The etag check through the write below is a single synchronous block — no `await` between
  // them — so only an *external* writer can invalidate the token, which is what it guards.
  const precondition = checkPrecondition(
    entry.bytes,
    firstHeader(req.headers["if-match"]),
    "overwrite",
  );
  if (!precondition.ok) {
    sendError(res, 412, PRECONDITION_FAILED[precondition.conflict]);
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
  const reply: WireTemplateWriteResponse = {
    id,
    relative_path: relative(resolve(ctx.project.dir), entry.absPath),
    etag,
  };
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
