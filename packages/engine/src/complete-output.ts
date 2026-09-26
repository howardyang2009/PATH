import { validateOutputSchema, type ConfigObject, type JsonValue, type OutputValidation, type WorkflowFile } from "@path/schema";
import { InterpolationError, interpolateValue } from "./interpolate.js";
import { resolveNode } from "./ref-tree.js";
import type { EnvSource } from "./resolve-env.js";

/**
 * **Is this output a valid Complete of this parked leaf?** (ADR 0040, server-api-v0.md §4.4) The leaf's
 * node must still be an awaiting node in the current file, and the output must satisfy its
 * `outputSchema`, interpolated against the config the run itself executes with.
 *
 * That last clause is why this sits behind `Project.complete` and not in a route: a Complete runs with
 * the tree's frozen launch config (ADR 0046) merged under anything supplied again, and only the Complete
 * door recovers it. A schema reading `${config.x}` where `x` came from the launch is judged against the
 * launch's value, not the file default.
 */

/** The one awaiting step type v1 ships (ADR 0039). */
export const AWAITING_STEP_TYPE = "person-activity";

export type OutputCheck =
  | { ok: true }
  /** The node was deleted or retyped mid-wait: the leaf can never validly complete (409). */
  | { ok: false; reason: "node-gone"; message: string }
  /** The schema could not be built, or the output does not satisfy it (400, leaf untouched). */
  | { ok: false; reason: "output-invalid"; message: string; details?: Extract<OutputValidation, { ok: false }>["issues"] };

export function checkCompletedOutput(args: {
  rootFile: WorkflowFile;
  workflowDir: string;
  files: Map<string, WorkflowFile> | undefined;
  /** The config the Complete run executes with (`continuationRunOptions`). */
  operatorConfig: ConfigObject | undefined;
  env: EnvSource;
  stepRunId: string;
  nodeId: string | null;
  output: JsonValue;
}): OutputCheck {
  const { stepRunId } = args;
  const resolved =
    args.nodeId === null
      ? undefined
      : resolveNode(args.rootFile, args.workflowDir, args.nodeId, { files: args.files, operatorConfig: args.operatorConfig, env: args.env });
  // The node union is the closed core set; a plugin leaf type is a runtime string outside it.
  if (resolved === undefined || (resolved.node.type as string) !== AWAITING_STEP_TYPE) {
    return {
      ok: false,
      reason: "node-gone",
      message: `step run "${stepRunId}" no longer maps to an ${AWAITING_STEP_TYPE} node in the workflow and cannot be completed`,
    };
  }

  // A node with no schema accepts any JSON.
  const rawSchema = (resolved.node as { outputSchema?: JsonValue }).outputSchema;
  if (rawSchema === undefined) return { ok: true };
  let schema: JsonValue;
  try {
    schema = interpolateValue(rawSchema, { config: resolved.config as unknown as JsonValue });
  } catch (err) {
    if (!(err instanceof InterpolationError)) throw err;
    return { ok: false, reason: "output-invalid", message: `output schema for step run "${stepRunId}" could not be resolved: ${err.message}` };
  }
  const validation = validateOutputSchema(schema, args.output);
  if (!validation.ok) {
    return { ok: false, reason: "output-invalid", message: "output does not match the step's outputSchema", details: validation.issues };
  }
  return { ok: true };
}
