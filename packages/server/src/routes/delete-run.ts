import { isTerminal } from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import { resolveRun } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `DELETE /v0/runs/:root_run_id` — permanently remove a root run from `path.db` and
 * `.path/runs/<root>/`. Refuses a non-terminal run (`409`: cancel first) and, unless `?force=true`,
 * a delete whose data a live successor still reuses (`409`). `404` means neither store held the id.
 */
export function handleDeleteRun({
  ctx,
  params: [rootRunId],
  query,
}: ApiRequest<[string]>): RouteReply {
  const force = query.get("force") === "true";

  // The root row specifically: a child can read terminal while the tree still runs.
  const address = resolveRun(ctx, rootRunId);
  if (!address.ok) return replyError(address.status, address.message);

  if (!isTerminal(address.root.status)) {
    return replyError(
      409,
      `run "${rootRunId}" is still ${address.root.status}; cancel it before deleting`,
    );
  }

  const blockers = ctx.project.archive.blockingSuccessors(rootRunId);
  if (blockers.length > 0 && !force) {
    return replyError(
      409,
      `refusing to delete ${rootRunId}: live successor run(s) reuse its data: ${blockers.join(", ")}` +
        ` — retry with ?force=true to delete it anyway`,
    );
  }

  if (!ctx.project.archive.remove(rootRunId)) {
    return replyError(404, `no run found with id "${rootRunId}"`);
  }

  return { status: 200, body: { root_run_id: rootRunId } };
}
