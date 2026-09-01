import type { ServerResponse } from "node:http";
import { RUN_STATUSES, toRootRunSummary, type ListRunsResponse, type RunStatus } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `GET /v0/runs` (server-api-v0.md §3): the root-run summary list. `limit` (default 50), `status`,
 * and `workflow_id` are query params; the summary carries only `run_id`/`status`/`started_at`/
 * `finished_at` — the full tree and output live at `GET /v0/runs/:root_run_id`.
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

  // `workflow_id` (#365): the Designer's per-workflow history, scoped to the file open on its canvas.
  // The scope key is the workflow's source-identity GUID, not its path (ADR 0015) — a server-side
  // `WHERE workflow_id = ?` past the latest-N window, composing with `limit`/`status`. Omitted, the
  // route is unchanged. Any GUID string is a valid filter; an unknown one matches nothing, so no
  // format check is needed (matching `path runs --workflow-id`, which also passes it straight through).
  // An absent *or empty* param is "omitted": a bare `?workflow_id=` reads as no filter, not as a
  // filter for the empty id (no root run has one), so the route stays unchanged rather than 200-ing [].
  const workflowId = query.get("workflow_id") || undefined;

  const rows = ctx.project.archive.listRoots({ limit, status, workflowId });
  const body: ListRunsResponse = { runs: rows.map(toRootRunSummary) };
  sendJson(res, 200, body);
}
