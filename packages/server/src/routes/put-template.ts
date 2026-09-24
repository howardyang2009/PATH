import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { relative, resolve } from "node:path";
import {
  makeStepTemplateSchema,
  makeWorkflowFileSchema,
  safeParseStepTemplateWith,
  safeParseWorkflowFileWith,
  type WireTemplateWriteResponse,
} from "@path/schema";
import { strongEtag } from "../etag.js";
import { readJsonBody, sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { discoverTemplates } from "../template-store.js";
import type { RunsRouteContext } from "./post-runs.js";
import { shippedTemplateDir } from "./template-common.js";

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
  ctx: RunsRouteContext,
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
  // `412`. The read-then-write below is a single synchronous block — no `await` between the etag check
  // and the write — so only an *external* writer can invalidate the token, which is what it guards.
  const ifMatch = firstHeader(req.headers["if-match"]);
  if (ifMatch === undefined) {
    sendError(res, 412, "precondition failed: If-Match required");
    return;
  }
  if (ifMatch !== strongEtag(entry.bytes)) {
    sendError(res, 412, "precondition failed: the template changed since it was read");
    return;
  }

  const rawBody = raw.value as Record<string, unknown>;
  if (rawBody.id !== id) {
    sendError(res, 400, "template id in body must match the URL id");
    return;
  }

  const validation =
    entry.kind === "step"
      ? safeParseStepTemplateWith(makeStepTemplateSchema(ctx.stepPlugins), rawBody)
      : safeParseWorkflowFileWith(makeWorkflowFileSchema(ctx.stepPlugins), rawBody);
  if (!validation.success) {
    sendError(res, 400, "template validation failed", validation.errors);
    return;
  }

  const serialized = `${JSON.stringify(rawBody, null, 2)}\n`;
  writeFileSync(entry.absPath, serialized);

  const etag = strongEtag(Buffer.from(serialized, "utf8"));
  const reply: WireTemplateWriteResponse = { id, relative_path: relative(projectDir, entry.absPath), etag };
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
