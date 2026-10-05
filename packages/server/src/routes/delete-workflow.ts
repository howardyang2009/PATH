import { type RouteReply, replyError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { workflowsOf } from "../workflow-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `DELETE /v0/workflows/file?path=<relative_path>&session_id=<id>` (server-api-v0.md §7.2) — the
 * Designer's Delete. `If-Match` is required and must match the current strong ETag (ADR 0016), so a
 * delete never removes unseen bytes; a live lease held by another session is a `409` (ADR 0017).
 *
 * A template path is refused (`400`) and a shipped one (`403`), as `PUT /v0/workflows` refuses them.
 */
export function handleDeleteWorkflow({ req, ctx, query }: ApiRequest): RouteReply {
  const path = query.get("path");
  if (path === null || path === "") return replyError(404, "not found");
  const removed = workflowsOf(ctx).remove(
    path,
    firstHeader(req.headers["if-match"]),
    query.get("session_id"),
  );
  if (!removed.ok) return replyError(removed.status, removed.message);

  return { status: 204 };
}
