import { isTerminal } from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import { resolveRun } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

/** `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2): answer 202 as soon as the abort is
 * signalled — the client learns the real terminal status from the SSE stream it already watches. */
export function handleCancelRun({ ctx, params: [rootRunId] }: ApiRequest<[string]>): RouteReply {
  // The tree's own root row answers: a child can read `succeeded` while the tree is still running,
  // and a 409 taken from it would refuse a live cancel.
  const address = resolveRun(ctx, rootRunId);
  if (!address.ok) return replyError(address.status, address.message);

  if (isTerminal(address.root.status)) {
    return replyError(
      409,
      `run "${rootRunId}" already finished with status "${address.root.status}"`,
    );
  }

  // A `running` row this server is not executing is real (`path run` shares the same
  // `.path/path.db`; a crashed process leaves one), and a parked `awaiting` tree is cancellable at
  // the store (ADR 0041).
  if (!ctx.live.cancel(rootRunId) && !ctx.project.cancel(rootRunId)) {
    return replyError(
      409,
      `run "${rootRunId}" is not executing in this server process and cannot be cancelled`,
    );
  }

  return { status: 202, body: { root_run_id: rootRunId } };
}
