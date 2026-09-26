import { isTerminal } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/** `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2): answer 202 as soon as the abort is
 * signalled — the client learns the real terminal status from the SSE stream it already watches. */
export function handleCancelRun({ res, ctx, params: [rootRunId] }: ApiRequest<[string]>): void {
  // Use the root row, never a child: a child can read `succeeded` while the tree is still running, and a 409 taken
  // from it would refuse a live cancel.
  const rootRow = ctx.project.archive.tree(rootRunId)?.root;
  if (!rootRow) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  if (isTerminal(rootRow.status)) {
    sendError(res, 409, `run "${rootRunId}" already finished with status "${rootRow.status}"`);
    return;
  }

  // A `running` row this server is not executing is real (`path run` shares the same `.path/path.db`;
  // a crashed process leaves one), and a parked `awaiting` tree is cancellable at the store (ADR 0041).
  if (!ctx.live.cancel(rootRunId) && !ctx.project.cancel(rootRunId)) {
    sendError(
      res,
      409,
      `run "${rootRunId}" is not executing in this server process and cannot be cancelled`,
    );
    return;
  }

  sendJson(res, 202, { root_run_id: rootRunId });
}
