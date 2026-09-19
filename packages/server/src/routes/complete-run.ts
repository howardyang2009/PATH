import type { IncomingMessage, ServerResponse } from "node:http";
import { InterpolationError, interpolateValue, resolveNode } from "@path/engine";
import { ConfigObjectSchema, formatIssues, type ConfigObject, type JsonValue } from "@path/schema";
import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareRunWorkflow } from "../launch.js";
import { validateOutputSchema } from "../output-schema.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4; ADR 0039/0040/0041) — resolve a parked
 * `awaiting` leaf with a person's output. The path names the **leaf**; the server derives its tree's
 * root (a tree holds many awaiting leaves) for the single-writer lease.
 *
 * **Validation runs before the lease** (§4.4). Validation is per-leaf, the lease per-tree, so validating
 * first means a bad submit on one leaf never contends for the lease and so never blocks a valid
 * concurrent Complete on a sibling. The order: resolve the leaf (unknown → `404`; not `awaiting` →
 * `409` naming the status); recover the current workflow file from the run's own row (`launch.ts`'s
 * `prepareRunWorkflow`: no recorded path or a swapped file → `409`, gone → `404`, invalid → `400`);
 * read *this* node's `outputSchema` by node id, re-interpolate it against the run's config, and
 * ajv-validate the output (ADR 0040 — a node with no schema accepts any JSON; invalid → `400` with the
 * ajv issues in `error.details`, leaf untouched). Only then does `Project.complete` take the per-root
 * lease, CAS the leaf `awaiting → succeeded`, write the output blob, and drive the tail in the
 * background. `202` carries `{ step_run_id, root_run_id }` so the client watches the root's SSE stream.
 *
 * Taxonomy: `404` unknown id / file gone; `409` not-`awaiting` (double-submit lands here, named by the
 * actual status), lease held, swapped-file / pre-#169 path, or a node an author deleted or retyped
 * mid-wait; `400` malformed body / missing or schema-invalid output / an `$env` in the config override;
 * `403` cross-origin (gated centrally in `create-server.ts`).
 */

// The one awaiting step type v1 ships (ADR 0039). A Complete is only valid against a node still of this
// type: an author who deleted or retyped the node mid-wait leaves the leaf with no valid exit but Cancel.
const AWAITING_STEP_TYPE = "person-activity";

/**
 * The body: the person's `output`, and an optional `config` override. The override exists because a
 * Complete recovers the launch's frozen config (ADR 0046) and a value that was a `$secret` is stored
 * only as its token — this is the door an operator supplies it again through. It carries the same
 * ADR 0012 `$env` reject as §2 and §4.3.
 */
const CompleteBodySchema = z.object({ output: z.unknown(), config: ConfigObjectSchema.optional() }).strict();

export async function handleCompleteRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  stepRunId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "invalid JSON body");
    return;
  }

  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    sendError(res, 400, "body must be a JSON object");
    return;
  }

  const parsed = CompleteBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const output = parsed.data.output as JsonValue;
  if (output === undefined) {
    sendError(res, 400, 'missing required field "output"');
    return;
  }
  const config = parsed.data.config as ConfigObject | undefined;
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

  // Find this leaf's node in the *current* file by its durable id, with the effective config that
  // reaches it (config crosses file boundaries; ADR 0022). A node the author deleted, or retyped away
  // from the awaiting type, can never validly complete — a `409`, the person's only exit being Cancel.
  const resolved =
    leaf.nodeId === null ? undefined : resolveNode(workflow.rootFile, workflow.workflowDir, leaf.nodeId, { files: workflow.files });
  // The node union is the closed core set; a plugin leaf type like `person-activity` is a runtime
  // string outside it, so the compare is over `string`.
  if (resolved === undefined || (resolved.node.type as string) !== AWAITING_STEP_TYPE) {
    sendError(
      res,
      409,
      `step run "${stepRunId}" no longer maps to an ${AWAITING_STEP_TYPE} node in the workflow and cannot be completed`,
    );
    return;
  }

  // `outputSchema` is author-supplied JSON Schema, re-interpolated against config (ADR 0040). A node
  // with none accepts any JSON. An unresolvable placeholder in the schema is a `400`: the schema the
  // person is held to cannot be built, so the submit cannot be judged.
  const rawSchema = (resolved.node as { outputSchema?: JsonValue }).outputSchema;
  if (rawSchema !== undefined) {
    let schema: JsonValue;
    try {
      schema = interpolateValue(rawSchema, { config: resolved.config as unknown as JsonValue });
    } catch (err) {
      if (err instanceof InterpolationError) {
        sendError(res, 400, `output schema for step run "${stepRunId}" could not be resolved: ${err.message}`);
        return;
      }
      throw err;
    }
    const validation = validateOutputSchema(schema, output);
    if (!validation.ok) {
      // Leaf untouched, no lease taken: the person may resubmit corrected output to the same route.
      sendError(res, 400, "output does not match the step's outputSchema", validation.issues);
      return;
    }
  }

  const result = await ctx.live.complete(workflow.rootFile, rootRunId, stepRunId, output, workflow.workflowDir, {
    files: workflow.files,
    // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
    registry: workflow.registry,
    // The override, if any: the engine merges it over the config the launch froze (ADR 0046), which is
    // how a `$secret` the launch stored as a token gets its value back for the tail.
    operatorConfig: config,
  });

  if (!result.ok) {
    // `not-found` → 404; `not-awaiting` (a submit that raced another to the leaf) and `lease-held` are
    // both 409 state conflicts. The engine owns the wording; the route only chooses the code.
    const status = result.reason === "not-found" ? 404 : 409;
    sendError(res, status, result.message);
    return;
  }

  sendJson(res, 202, { step_run_id: stepRunId, root_run_id: result.rootRunId });
}
