import {
  type ListRunsResponse,
  RUN_STATUSES,
  type RunRecord,
  type RunStatus,
  toRootRunSummary,
} from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import { liveDisplayStatus } from "../live-status.js";
import type { ApiRequest, RouteContext } from "./route-context.js";

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
      return replyError(400, "runs.invalid-limit", { limit: limitParam });
    }
  }

  const statusParam = query.get("status");
  if (statusParam !== null && !RUN_STATUSES.includes(statusParam as RunStatus)) {
    return replyError(400, "runs.invalid-status", {
      status: statusParam,
      statuses: RUN_STATUSES.join(", "),
    });
  }
  const status = statusParam === null ? undefined : (statusParam as RunStatus);

  // Scopes the list to the workflow's source-identity GUID, not its path (ADR 0015). An absent *or
  // empty* param means "no filter"; an unknown GUID matches nothing, so no format check is needed.
  const workflowId = query.get("workflow_id") || undefined;

  const rows = listRoots(ctx, { limit, status, workflowId });
  // Each summary carries the masked-secret *names* its launch recorded (ADR 0046), never values.
  const body: ListRunsResponse = {
    runs: rows.map(({ row, display }) =>
      toRootRunSummary(row, display, ctx.store.archive.launchFacts(row.runId)?.secretKeys),
    ),
  };
  return { status: 200, body };
}

/** The page of roots with each one's display status as it stands live. A stored `running` root can
 * display either in-flight status, so those filters read both and filter on the live one. */
function listRoots(
  ctx: RouteContext,
  options: { limit?: number; status?: RunStatus; workflowId?: string },
): { row: RunRecord; display: RunStatus }[] {
  const { archive } = ctx.store;
  const withDisplay = (row: RunRecord) => ({ row, display: liveDisplay(ctx, row) });
  if (options.status !== "running" && options.status !== "awaiting") {
    return archive.listRoots(options).map(withDisplay);
  }
  const all = { ...options, limit: Number.MAX_SAFE_INTEGER };
  const inFlight = [
    ...archive.listRoots({ ...all, status: "running" }),
    ...archive.listRoots({ ...all, status: "awaiting" }),
  ];
  return inFlight
    .map(withDisplay)
    .filter(({ display }) => display === options.status)
    .sort((a, b) => (b.row.startedAt ?? "").localeCompare(a.row.startedAt ?? ""))
    .slice(0, options.limit ?? 50);
}

function liveDisplay(ctx: RouteContext, root: RunRecord): RunStatus {
  const unstored = ctx.live.unstored(root.runId);
  if (unstored.length === 0) return ctx.store.archive.displayStatus(root);
  const rows = ctx.store.archive.tree(root.runId)?.runs ?? [root];
  return liveDisplayStatus(rows, unstored).get(root.runId) ?? root.status;
}
