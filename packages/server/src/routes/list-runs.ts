import {
  type ListRunsResponse,
  RUN_STATUSES,
  type RunStatus,
  toRootRunSummary,
} from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/runs` (server-api-v0.md §3): the root-run summary list. `limit` (default 50), `status`,
 * and `workflow_id` are query params; the full tree and output live at `GET /v0/runs/:root_run_id`.
 */
export function handleListRuns({ ctx, query }: ApiRequest): RouteReply {
  const limitParam = query.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1) {
      return replyError(400, `invalid limit "${limitParam}": must be a positive integer`);
    }
  }

  const statusParam = query.get("status");
  if (statusParam !== null && !RUN_STATUSES.includes(statusParam as RunStatus)) {
    return replyError(
      400,
      `invalid status "${statusParam}": must be one of ${RUN_STATUSES.join(", ")}`,
    );
  }
  const status = statusParam === null ? undefined : (statusParam as RunStatus);

  // Scopes the list to the workflow's source-identity GUID, not its path (ADR 0015). An absent *or
  // empty* param means "no filter"; an unknown GUID matches nothing, so no format check is needed.
  const workflowId = query.get("workflow_id") || undefined;

  const rows = ctx.store.archive.listRoots({ limit, status, workflowId });
  // Each summary carries the masked-secret *names* its launch recorded (ADR 0046), never values.
  const body: ListRunsResponse = {
    runs: rows.map((row) =>
      toRootRunSummary(
        row,
        ctx.store.archive.displayStatus(row),
        ctx.store.archive.launchFacts(row.runId)?.secretKeys,
      ),
    ),
  };
  return { status: 200, body };
}
