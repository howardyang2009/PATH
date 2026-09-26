import { type ConfigObject, ConfigObjectSchema, type JsonValue } from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4) — resolve a parked `awaiting` leaf with
 * a person's output. The path names the leaf; the per-tree lease is taken from its root. Validation is
 * per-leaf and runs before the lease, so a bad submit never blocks a sibling's Complete.
 */

/**
 * Body: `output` plus an optional `config` override — the door an operator re-supplies a launch-frozen
 * `$secret` through (ADR 0046). Same ADR 0012 `$env` reject as §2.
 */
const CompleteBodySchema = z
  .object({ output: z.unknown(), config: ConfigObjectSchema.optional() })
  .strict();

export async function handleCompleteRun({
  req,
  res,
  ctx,
  params: [stepRunId],
}: ApiRequest<[string]>): Promise<void> {
  const body = await readRequestBody(req, res, CompleteBodySchema);
  if (!body) return;
  const output = body.data.output as JsonValue;
  if (output === undefined) {
    sendError(res, 400, 'missing required field "output"');
    return;
  }
  const config = body.data.config as ConfigObject | undefined;
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) {
      sendError(res, 400, envError);
      return;
    }
  }

  // Resolve the leaf's tree from one read; unknown id is a 404 before any file work.
  const rootRunId = ctx.project.archive.rootRunIdOf(stepRunId);
  const tree = rootRunId === null ? null : ctx.project.archive.tree(rootRunId);
  const leaf = tree?.runs.find((r) => r.runId === stepRunId);
  if (rootRunId === null || tree === null || leaf === undefined) {
    sendError(res, 404, `no step run found with id "${stepRunId}"`);
    return;
  }

  // The compare half of the leaf CAS, checked before reload/lease so an ordinary double-submit never
  // contends. The engine repeats it under the lease to close the concurrent-submit race.
  if (leaf.status !== "awaiting") {
    sendError(res, 409, `step run "${stepRunId}" is ${leaf.status}, not awaiting`);
    return;
  }

  const root = tree.root;
  if (!root) {
    sendError(res, 409, `run "${rootRunId}" has no recorded workflow path and cannot be completed`);
    return;
  }

  // Recover and re-validate the workflow as it stands now: the node lookup below must be a lookup in
  // *this run's* file (matching id, ADR 0006), not merely one sharing the node's id.
  const prepared = await prepareRunWorkflow(ctx.project.dir, root, {
    notFound: () => `workflow file for run "${rootRunId}" not found at "${root.workflowPath}"`,
    noPath: () => `run "${rootRunId}" has no recorded workflow path and cannot be completed`,
    swapped: (workflowPath) =>
      `the workflow at "${workflowPath}" is no longer the one run "${rootRunId}" ran (its id changed); cannot complete`,
  });
  if (!prepared.ok) {
    sendError(res, prepared.refusal.status, prepared.refusal.message, prepared.refusal.details);
    return;
  }
  const { workflow } = prepared;

  const result = await ctx.live.complete(
    workflow.rootFile,
    rootRunId,
    stepRunId,
    output,
    workflow.workflowDir,
    {
      files: workflow.files,
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
      registry: workflow.registry,
      // Merged over the config the launch froze (ADR 0046).
      operatorConfig: config,
    },
  );

  if (!result.ok) {
    // `not-found` → 404; `output-invalid` → 400 with issues; the rest are 409 state conflicts.
    if (result.reason === "output-invalid") {
      sendError(res, 400, result.message, result.details);
      return;
    }
    sendError(res, result.reason === "not-found" ? 404 : 409, result.message);
    return;
  }

  sendJson(res, 202, { step_run_id: stepRunId, root_run_id: result.rootRunId });
}
