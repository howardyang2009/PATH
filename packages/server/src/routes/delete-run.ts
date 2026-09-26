import { isTerminal } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `DELETE /v0/runs/:root_run_id` — permanently remove a root run from `path.db` and `.path/runs/<root>/`.
 * Refuses a non-terminal run (`409`: cancel first) and, unless `?force=true`, a delete whose data a live
 * successor still reuses (`409`). `404` means neither store held the id.
 */
export function handleDeleteRun({
  res,
  ctx,
  params: [rootRunId],
  query,
}: ApiRequest<[string]>): void {
  const force = query.get("force") === "true";

  // The root row specifically: a child can read terminal while the tree still runs.
  const rootRow = ctx.project.archive.tree(rootRunId)?.root;
  if (!rootRow) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  if (!isTerminal(rootRow.status)) {
    sendError(res, 409, `run "${rootRunId}" is still ${rootRow.status}; cancel it before deleting`);
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
