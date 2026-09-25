import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { confineToProjectRoot } from "../confine.js";
import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import type { RunsRouteContext } from "./post-runs.js";
import { isTemplatePath } from "./put-workflow.js";
import { readLease, resolveMarker } from "./workflow-lock.js";

/**
 * `DELETE /v0/workflows/file?path=<relative_path>&session_id=<id>` (server-api-v0.md §7.2): remove one
 * workflow file, the Designer's Delete. Origin-gated centrally. It guards the bytes exactly as the write
 * door does (ADR 0016): `If-Match` is **required** and must match the file's current strong ETag, so a
 * delete never removes bytes the caller has not seen. A live edit lease held by *another* session is a
 * `409` (ADR 0017); the caller's own lease, or an expired one, is removed with the file.
 *
 * A template path is refused (`400`), as `PUT /v0/workflows` refuses one (§10.6): a template is deleted
 * through `DELETE /v0/templates/:id`. Other workflows that reference this file keep their ref; the
 * Designer's problems pass reports it as dangling.
 */
export function handleDeleteWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  path: string | null,
  sessionId: string | null,
): void {
  if (path === null || path === "") {
    sendError(res, 404, "not found");
    return;
  }
  if (isTemplatePath(resolve(ctx.project.dir), path)) {
    sendError(res, 400, "workflow path must not be a template path");
    return;
  }

  const absPath = confineToProjectRoot(resolve(ctx.project.dir), path);
  const markerPath = resolveMarker(ctx, path);
  if (absPath === undefined || markerPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  // Read-decide-delete is one synchronous block (no `await`), the write door's concurrency stance.
  let currentBytes: Buffer;
  try {
    currentBytes = readFileSync(absPath);
  } catch {
    sendError(res, 404, "not found");
    return;
  }

  const ifMatch = firstHeader(req.headers["if-match"]);
  if (ifMatch === undefined) {
    sendError(res, 412, "precondition failed: send If-Match to delete");
    return;
  }
  if (ifMatch !== strongEtag(currentBytes)) {
    sendError(res, 412, "precondition failed: the file changed since it was read");
    return;
  }

  const { lease } = readLease(markerPath);
  if (lease !== undefined && Date.now() <= Date.parse(lease.expires_at) && lease.session_id !== sessionId) {
    sendError(res, 409, "workflow is being edited in another session");
    return;
  }

  rmSync(absPath);
  rmSync(markerPath, { force: true });
  res.writeHead(204);
  res.end();
}
