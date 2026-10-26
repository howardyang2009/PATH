import { ConfigObjectSchema, type StartRunResponse } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyError, replyRefusal } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import { ResumeNotFound, ResumeRefused, type StartedRun } from "../live-runs.js";
import { resolveRun } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

/** Optional `config` override, and `rerun_from_run_id` — the rerun boundary K's source run id (ADR
 * 0032). */
const ResumeBodySchema = z
  .object({ config: ConfigObjectSchema.optional(), rerun_from_run_id: z.string().optional() })
  .strict();

/**
 * `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3) — re-runs a finished-but-unsuccessful
 * root run as a **successor** (ADR 0001). No `input`: a resumed run restores its context from the
 * predecessor's tree, so a fresh seed would be discarded.
 */
export async function handleResumeRun({
  body,
  ctx,
  params: [rootRunId],
}: ApiRequest<[string]>): Promise<RouteReply> {
  const parsed = readRequestBody(body, ResumeBodySchema);
  if (!parsed.ok) return parsed.reply;
  const { config, rerun_from_run_id: rerunFromRunId } = parsed.data;
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) return replyRefusal(400, envError);
  }

  // The predecessor's root row — never another row whose status could disagree with the root's.
  const address = resolveRun(ctx, rootRunId);
  if (!address.ok) return replyRefusal(address.status, address);
  const { root } = address;

  // Recover and re-validate the workflow as it stands now: gone → `404`, now-invalid → `400`, no
  // longer this run's workflow (id changed, ADR 0006) → `409`. No `escapesRoot`: the path came from
  // our own row.
  const prepared = await prepareRunWorkflow(ctx.layout, root, {
    notFound: () => ({
      code: "run.workflow-missing",
      params: { rootRunId, workflowPath: root.workflowPath ?? "" },
    }),
    noRun: () => ({ code: "run.not-found", params: { rootRunId } }),
    noPath: () => ({ code: "run.resume.no-path", params: { rootRunId } }),
    swapped: (workflowPath) => ({
      code: "run.resume.swapped",
      params: { workflowPath, rootRunId },
    }),
  });
  if (!prepared.ok) {
    return replyRefusal(prepared.refusal.status, prepared.refusal, prepared.refusal.details);
  }
  const { workflow } = prepared;

  let ids: StartedRun;
  try {
    ids = await ctx.live.resume(workflow.rootFile, rootRunId, workflow.workflowDir, {
      files: workflow.files,
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no
      // re-scan.
      registry: workflow.registry,
      // The operator's override — shadows the declared config key by key, for the steps that
      // re-run.
      operatorConfig: config,
      sourceWorkflowPath: workflow.storeRelativePath(ctx.layout.projectDir),
      // The rerun boundary K, forwarded verbatim: the route does no K-logic; `Project.resume`
      // validates.
      rerunFromRunId,
      // Read again now, so a rotated or deleted User secret takes effect (ADR 0089).
      userSecrets: ctx.secrets?.values(),
    });
  } catch (err) {
    // The row vanished between the check above and the engine's own lookup (a concurrent `rm`).
    if (err instanceof ResumeNotFound) {
      return replyError(404, "run.not-found", { rootRunId });
    }
    // A refusal from the engine's one Resume gate (a live or fully succeeded tree, or an illegal
    // K), before any successor started. The route only translates.
    if (err instanceof ResumeRefused) {
      return replyRefusal(err.refusal.status, err.refusal);
    }
    return replyError(500, "run.resume.start-failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const started: StartRunResponse = { run_id: ids.runId, root_run_id: ids.rootRunId };
  return { status: 202, body: started };
}
