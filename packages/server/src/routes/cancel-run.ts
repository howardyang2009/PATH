import type { ServerResponse } from "node:http";
import { getRunsForRoot, type RunStatus } from "@path/engine";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/** Statuses a run cannot be cancelled out of — it already finished (mvp spec §5.7). */
const TERMINAL_STATUSES = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

/**
 * `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2) — a named action, not a mutation of a
 * status field and not a `DELETE`: the run record is the audit trail and must survive a cancel.
 *
 * Answers `202` as soon as the abort is *signalled*, mirroring `POST /v0/runs`: an in-flight SDK
 * turn can take seconds to unwind and there is no bound to hang a request on, so the client learns
 * the real terminal status from the SSE stream it is already watching. Nothing here is special-cased
 * for that stream — the run's terminal events flow through the hub exactly as a failure's would.
 *
 * The three refusals exist so the route never promises a stop it cannot perform; each names a
 * different reason, because "cannot cancel" is not one condition.
 */
export function handleCancelRun(res: ServerResponse, ctx: RunsRouteContext, rootRunId: string): void {
  // The root row is the one whose own id is the root id (an invariant of the run tree, §1). Unlike
  // `GET /v0/runs/:root_run_id`, which can still report a tree when that row is missing, this route
  // must not fall back to some other row of the tree: a child can read `succeeded` while the tree is
  // still running, and a terminal 409 taken from it would refuse the cancel of a live run.
  const rootRow = getRunsForRoot(ctx.project.db, rootRunId).find((row) => row.runId === rootRunId);
  if (!rootRow) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  if (TERMINAL_STATUSES.has(rootRow.status)) {
    sendError(res, 409, `run "${rootRunId}" already finished with status "${rootRow.status}"`);
    return;
  }

  // A `running` row this server holds no controller for is a real case, not a theoretical one:
  // `path run` writes to the same `.path/path.db`, so a CLI-launched run is visible here, and a run
  // left behind by an earlier crashed process sits in the db as `running` forever.
  if (!ctx.controllers.abort(rootRunId)) {
    sendError(
      res,
      409,
      `run "${rootRunId}" is not executing in this server process and cannot be cancelled`,
    );
    return;
  }

  // A second cancel of a genuinely running run finds the same controller and aborts it again — a
  // no-op — so a double click answers 202 twice rather than needing special handling.
  sendJson(res, 202, { root_run_id: rootRunId });
}
