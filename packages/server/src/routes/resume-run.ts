import { ConfigObjectSchema, isTerminal, type StartRunResponse } from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import { ResumeNotFound, ResumeRefused, type StartedRun } from "../live-runs.js";
import type { ApiRequest } from "./route-context.js";

/** Optional `config` override, and `rerun_from_run_id` — the rerun boundary K's source run id (ADR 0032). */
const ResumeBodySchema = z
  .object({ config: ConfigObjectSchema.optional(), rerun_from_run_id: z.string().optional() })
  .strict();

/**
 * `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3) — re-runs a finished-but-unsuccessful
 * root run as a **successor** (ADR 0001). No `input`: a resumed run restores its context from the
 * predecessor's tree, so a fresh seed would be discarded.
 */
export async function handleResumeRun({
  req,
  res,
  ctx,
  params: [rootRunId],
}: ApiRequest<[string]>): Promise<void> {
  const body = await readRequestBody(req, res, ResumeBodySchema);
  if (!body) return;
  const { config, rerun_from_run_id: rerunFromRunId } = body.data;
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) {
      sendError(res, 400, envError);
      return;
    }
  }

  // The predecessor's root row — never another row whose status could disagree with the root's.
  const root = ctx.project.archive.tree(rootRunId)?.root;
  if (!root) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  // A still-running run has nothing to resume yet; a succeeded run has nothing left to do.
  if (!isTerminal(root.status)) {
    sendError(
      res,
      409,
      `run "${rootRunId}" is still ${root.status}; only a finished run can be resumed`,
    );
    return;
  }
  // A Resume-from-K target is legitimately succeeded (ADR 0032), so the already-succeeded refusal is
  // relaxed exactly when `rerun_from_run_id` is supplied; plain Resume's gate is unchanged.
  if (root.status === "succeeded" && rerunFromRunId === undefined) {
    sendError(res, 409, `run "${rootRunId}" already succeeded; there is nothing to resume`);
    return;
  }

  // Recover and re-validate the workflow as it stands now: gone → `404`, now-invalid → `400`, no longer
  // this run's workflow (id changed, ADR 0006) → `409`. No `escapesRoot`: the path came from our own row.
  const prepared = await prepareRunWorkflow(ctx.project.dir, root, {
    notFound: () => `workflow file for run "${rootRunId}" not found at "${root.workflowPath}"`,
    noPath: () => `run "${rootRunId}" has no recorded workflow path and cannot be resumed`,
    swapped: (workflowPath) =>
      `the workflow at "${workflowPath}" is no longer the one run "${rootRunId}" ran (its id changed); cannot resume`,
  });
  if (!prepared.ok) {
    sendError(res, prepared.refusal.status, prepared.refusal.message, prepared.refusal.details);
    return;
  }
  const { workflow } = prepared;

  let ids: StartedRun;
  try {
    ids = await ctx.live.resume(workflow.rootFile, rootRunId, workflow.workflowDir, {
      files: workflow.files,
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
      registry: workflow.registry,
      // The operator's override — shadows the declared config key by key, for the steps that re-run.
      operatorConfig: config,
      sourceWorkflowPath: workflow.storeRelativePath(ctx.project.dir),
      // The rerun boundary K, forwarded verbatim: the route does no K-logic; `Project.resume` validates.
      rerunFromRunId,
    });
  } catch (err) {
    // The row vanished between the check above and the engine's own lookup (a concurrent `rm`).
    if (err instanceof ResumeNotFound) {
      sendError(res, 404, `no run found with id "${rootRunId}"`);
      return;
    }
    // A Resume-from-K refusal: the engine's one legal-K authority rejected the selection before any
    // successor started. The route only translates.
    if (err instanceof ResumeRefused) {
      sendError(res, err.status, err.message);
      return;
    }
    sendError(
      res,
      500,
      `resume failed to start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const started: StartRunResponse = { run_id: ids.runId, root_run_id: ids.rootRunId };
  sendJson(res, 202, started);
}
