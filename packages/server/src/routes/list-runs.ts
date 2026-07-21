import type { ServerResponse } from "node:http";
import { listRootRuns, type RunStatus } from "@path/engine";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

const RUN_STATUSES: readonly RunStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];

/**
 * `GET /v0/runs` (server-api-v0.md §3): the root-run summary list. `limit` (default 50) and
 * `status` are query params; the summary carries only `run_id`/`status`/`started_at`/`finished_at`
 * — the full tree and output live at `GET /v0/runs/:root_run_id`.
 */
export function handleListRuns(res: ServerResponse, ctx: RunsRouteContext, query: URLSearchParams): void {
  const limitParam = query.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1) {
      sendError(res, 400, `invalid limit "${limitParam}": must be a positive integer`);
      return;
    }
  }

  const statusParam = query.get("status");
  if (statusParam !== null && !RUN_STATUSES.includes(statusParam as RunStatus)) {
    sendError(res, 400, `invalid status "${statusParam}": must be one of ${RUN_STATUSES.join(", ")}`);
    return;
  }
  const status = statusParam === null ? undefined : (statusParam as RunStatus);

  const rows = listRootRuns(ctx.db, { limit, status });
  sendJson(res, 200, {
    runs: rows.map((row) => ({
      run_id: row.runId,
      status: row.status,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
    })),
  });
}
