import type { ServerResponse } from "node:http";
import { isTerminal } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `DELETE /v0/runs/:root_run_id` — permanently remove a root run's data from both stores: its rows
 * in `path.db` and its blob tree under `.path/runs/<root>/`. The destructive twin of `path runs rm`
 * (engine `RunArchive.remove`), reached from the viewer's per-run delete affordance.
 *
 * Two refusals guard the delete, each a different reason:
 *
 * - **Still running.** A non-terminal root must not be deleted out from under an executing process:
 *   its rows are still being written. The caller cancels it first (`409`). Only a settled run —
 *   succeeded / failed / cancelled — is deletable.
 * - **Live successor.** A later run that resumed from this one reuses its data (reuse markers); the
 *   default refuses (`409`) so the delete never strands a dangling reference. `?force=true` overrides
 *   it, mirroring `path runs rm --force`.
 *
 * `remove` returning `false` means neither store held anything for the id — a `404`, either an
 * unknown id or one already deleted (a double-click after the list refreshed). The `200` body echoes
 * `{ root_run_id }`, which the caller passed in.
 */
export function handleDeleteRun(
  res: ServerResponse,
  ctx: RunsRouteContext,
  rootRunId: string,
  force: boolean,
): void {
  // The root row specifically (as `cancel` does): a child can read terminal while the tree still
  // runs, so a status taken from any other row could wrongly clear the "still running" guard.
  const rootRow = ctx.project.archive.tree(rootRunId)?.root;
  if (!rootRow) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  if (!isTerminal(rootRow.status)) {
    sendError(
      res,
      409,
      `run "${rootRunId}" is still ${rootRow.status}; cancel it before deleting`,
    );
    return;
  }

  const blockers = ctx.project.archive.blockingSuccessors(rootRunId);
  if (blockers.length > 0 && !force) {
    sendError(
      res,
      409,
      `refusing to delete ${rootRunId}: live successor run(s) reuse its data: ${blockers.join(", ")}` +
        ` — retry with ?force=true to delete it anyway`,
    );
    return;
  }

  if (!ctx.project.archive.remove(rootRunId)) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  sendJson(res, 200, { root_run_id: rootRunId });
}
