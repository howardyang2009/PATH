import { resolve } from "node:path";
import { conditionalDelete, PRECONDITION_FAILED } from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { editLease } from "../edit-lease.js";
import { sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { isTemplatePath } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `DELETE /v0/workflows/file?path=<relative_path>&session_id=<id>` (server-api-v0.md §7.2) — the
 * Designer's Delete. `If-Match` is required and must match the current strong ETag (ADR 0016), so a
 * delete never removes unseen bytes; a live lease held by another session is a `409` (ADR 0017).
 *
 * A template path is refused (`400`), as `PUT /v0/workflows` refuses one (§10.6).
 */
export function handleDeleteWorkflow({ req, res, ctx, query }: ApiRequest): void {
  const path = query.get("path");
  const sessionId = query.get("session_id");

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

  // The lease first: another session editing the file outranks a stale token, and either way the
  // file is untouched.
  if (lease.heldByOther(sessionId)) {
    sendError(res, 409, "workflow is being edited in another session");
    return;
  }

  // One call reads, decides and removes — the write door's concurrency stance.
  const removed = conditionalDelete(absPath, firstHeader(req.headers["if-match"]));
  if (!removed.ok) {
    // A file that is already gone is this route's `404`; a missing or stale token is the `412`.
    if (removed.conflict === "missing") sendError(res, 404, "not found");
    else sendError(res, 412, PRECONDITION_FAILED[removed.conflict]);
    return;
  }

  lease.remove();
  res.writeHead(204);
  res.end();
}
