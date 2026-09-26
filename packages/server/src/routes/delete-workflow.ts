import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  checkPrecondition,
  deleteArtifact,
  PRECONDITION_FAILED,
  readArtifact,
} from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { editLease } from "../edit-lease.js";
import { sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { isTemplatePath } from "../template-store.js";
import type { RouteContext } from "./route-context.js";

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
  ctx: RouteContext,
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
  const lease = editLease(ctx.project.dir, path);
  if (absPath === undefined || lease === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  // Read-decide-delete is one synchronous block (no `await`), the write door's concurrency stance.
  const currentBytes = readArtifact(absPath);
  if (currentBytes === undefined) {
    sendError(res, 404, "not found");
    return;
  }
  const precondition = checkPrecondition(
    currentBytes,
    firstHeader(req.headers["if-match"]),
    "overwrite",
  );
  if (!precondition.ok) {
    sendError(res, 412, PRECONDITION_FAILED[precondition.conflict]);
    return;
  }

  if (lease.heldByOther(sessionId)) {
    sendError(res, 409, "workflow is being edited in another session");
    return;
  }

  deleteArtifact(absPath);
  lease.remove();
  res.writeHead(204);
  res.end();
}
