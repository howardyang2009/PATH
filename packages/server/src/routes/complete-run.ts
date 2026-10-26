import { type ConfigObject, ConfigObjectSchema, type JsonValue } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyError, replyRefusal } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import { resolveLeaf } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4) — resolve a parked `awaiting` leaf
 * with a person's output. The path names the leaf; the per-tree lease is taken from its root.
 * Validation is per-leaf and runs before the lease, so a bad submit never blocks a sibling's
 * Complete.
 */

/**
 * Body: `output` plus an optional `config` override — the door an operator re-supplies a
 * launch-frozen `$secret` through (ADR 0046). Same ADR 0012 `$env` reject as §2.
 */
const CompleteBodySchema = z
  .object({ output: z.unknown(), config: ConfigObjectSchema.optional() })
  .strict();

export async function handleCompleteRun({
  body,
  ctx,
  params: [stepRunId],
}: ApiRequest<[string]>): Promise<RouteReply> {
  const parsed = readRequestBody(body, CompleteBodySchema);
  if (!parsed.ok) return parsed.reply;
  const output = parsed.data.output as JsonValue;
  if (output === undefined) return replyError(400, "run.complete.missing-output");
  const config = parsed.data.config as ConfigObject | undefined;
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) return replyRefusal(400, envError);
  }

  // Resolve the leaf's tree from one read; unknown id is a 404 before any file work.
  const address = resolveLeaf(ctx, stepRunId);
  if (!address.ok) return replyRefusal(address.status, address);
  const { rootRunId, leaf } = address;

  // The compare half of the leaf CAS, checked before reload/lease so an ordinary double-submit
  // never contends. The engine repeats it under the lease to close the concurrent-submit race.
  if (leaf.status !== "awaiting") {
    return replyError(409, "run.complete.not-awaiting", { stepRunId, status: leaf.status });
  }

  const { root } = address;
  if (!root) {
    return replyError(409, "run.complete.no-path", { rootRunId });
  }

  // Recover and re-validate the workflow as it stands now: the node lookup below must be a lookup
  // in *this run's* file (matching id, ADR 0006), not merely one sharing the node's id.
  const prepared = await prepareRunWorkflow(ctx.layout, root, {
    notFound: () => ({
      code: "run.workflow-missing",
      params: { rootRunId, workflowPath: root.workflowPath ?? "" },
    }),
    noRun: () => ({ code: "run.step-not-found", params: { stepRunId } }),
    noPath: () => ({ code: "run.complete.no-path", params: { rootRunId } }),
    swapped: (workflowPath) => ({
      code: "run.complete.swapped",
      params: { workflowPath, rootRunId },
    }),
  });
  if (!prepared.ok) {
    return replyRefusal(prepared.refusal.status, prepared.refusal, prepared.refusal.details);
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
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no
      // re-scan.
      registry: workflow.registry,
      // Merged over the config the launch froze (ADR 0046).
      operatorConfig: config,
      // Read again now, so a rotated or deleted User secret takes effect (ADR 0089).
      userSecrets: ctx.secrets?.values(),
    },
  );

  if (!result.ok) {
    // `not-found` → 404; `output-invalid` → 400 with issues; the rest are 409 state conflicts.
    if (result.reason === "output-invalid") {
      return replyError(400, "run.refused", { message: result.message }, result.details);
    }
    // The engine's own words until its refusals carry codes.
    return replyError(result.reason === "not-found" ? 404 : 409, "run.refused", {
      message: result.message,
    });
  }

  return { status: 202, body: { step_run_id: stepRunId, root_run_id: result.rootRunId } };
}
