import { type ConfigObject, ConfigObjectSchema, type JsonValue } from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4; ADR 0039/0040/0041) — resolve a parked
 * `awaiting` leaf with a person's output. The path names the **leaf**; the server derives its tree's
 * root (a tree holds many awaiting leaves) for the single-writer lease.
 *
 * **Validation runs before the lease** (§4.4). Validation is per-leaf, the lease per-tree, so validating
 * first means a bad submit on one leaf never contends for the lease and so never blocks a valid
 * concurrent Complete on a sibling. The order: resolve the leaf (unknown → `404`; not `awaiting` →
 * `409` naming the status); recover the current workflow file from the run's own row (`launch.ts`'s
 * `prepareRunWorkflow`: no recorded path or a swapped file → `409`, gone → `404`, invalid → `400`).
 * `Project.complete` then checks the output against *this* node's `outputSchema`, interpolated against
 * the config the run executes with (ADR 0040/0046 — invalid → `400` with the ajv issues in
 * `error.details`, leaf untouched), and only then takes the per-root lease, CASes the leaf
 * `awaiting → succeeded`, writes the output blob, and drives the tail. `202` carries `{ step_run_id, root_run_id }` so the client watches the root's SSE stream.
 *
 * Taxonomy: `404` unknown id / file gone; `409` not-`awaiting` (double-submit lands here, named by the
 * actual status), lease held, swapped-file / pre-#169 path, or a node an author deleted or retyped
 * mid-wait; `400` malformed body / missing or schema-invalid output / an `$env` in the config override;
 * `403` cross-origin (gated centrally in `create-server.ts`).
 */

/**
 * The body: the person's `output`, and an optional `config` override. The override exists because a
 * Complete recovers the launch's frozen config (ADR 0046) and a value that was a `$secret` is stored
 * only as its token — this is the door an operator supplies it again through. It carries the same
 * ADR 0012 `$env` reject as §2 and §4.3.
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

  // Resolve the leaf and its tree from one read. An unknown id is a `404` before any file work; the
  // leaf names its tree, whose root row carries the workflow path to reload and keys the lease.
  const rootRunId = ctx.project.archive.rootRunIdOf(stepRunId);
  const tree = rootRunId === null ? null : ctx.project.archive.tree(rootRunId);
  const leaf = tree?.runs.find((r) => r.runId === stepRunId);
  if (rootRunId === null || tree === null || leaf === undefined) {
    sendError(res, 404, `no step run found with id "${stepRunId}"`);
    return;
  }

  // The compare half of the leaf CAS, checked here so a non-`awaiting` leaf (an already-succeeded step,
  // a plain double-submit) is a `409` *before* the file is reloaded and before any lease — it never
  // reaches validation. The engine repeats the check under the lease to close the concurrent-submit
  // race; this pre-check keeps the ordinary double-submit off the lease entirely.
  if (leaf.status !== "awaiting") {
    sendError(res, 409, `step run "${stepRunId}" is ${leaf.status}, not awaiting`);
    return;
  }

  const root = tree.root;
  if (!root) {
    sendError(res, 409, `run "${rootRunId}" has no recorded workflow path and cannot be completed`);
    return;
  }

  // Recover and re-validate the workflow as it stands now (`launch.ts`'s `prepareRunWorkflow`, the
  // same gate a fresh launch and a resume run): no recorded path is a `409`, a moved file is a `404`,
  // an invalid one a `400`, and a file that is no longer the workflow this run ran (its id changed,
  // ADR 0006) a `409`. A relocated store must still resolve for the replay, and the node lookup below
  // must be a lookup in *this run's* file, not merely one that happens to share the node's id.
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
      // The override, if any: the engine merges it over the config the launch froze (ADR 0046), which is
      // how a `$secret` the launch stored as a token gets its value back for the tail.
      operatorConfig: config,
    },
  );

  if (!result.ok) {
    // `not-found` → 404; `output-invalid` → 400 with the validator's issues; `not-awaiting` (a submit
    // that raced another to the leaf), `lease-held` and `node-gone` are 409 state conflicts. The engine
    // owns the wording; the route only chooses the code.
    if (result.reason === "output-invalid") {
      sendError(res, 400, result.message, result.details);
      return;
    }
    sendError(res, result.reason === "not-found" ? 404 : 409, result.message);
    return;
  }

  sendJson(res, 202, { step_run_id: stepRunId, root_run_id: result.rootRunId });
}
