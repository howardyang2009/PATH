import {
  AWAITING_STEP_TYPE,
  type ConfigObject,
  type JsonValue,
  type OutputValidation,
  validateOutputSchema,
  type WorkflowFile,
} from "@path/schema";
import { type CodedRefusal, refusal } from "./failure.js";
import { InterpolationError, interpolateValue, scopeFor } from "./interpolate.js";
import { resolveNode } from "./ref-tree.js";
import type { EnvSource } from "./resolve-env.js";

/**
 * Is this output a valid Complete of this parked leaf? (server-api-v0.md §4.4) The node must still
 * be an awaiting node and the output must satisfy its `outputSchema`, interpolated against the
 * config the run executes with: the tree's frozen launch config merged under anything supplied
 * again, which is why this sits behind `Project.complete` rather than in a route.
 */

export type OutputCheck =
  | { ok: true }
  /** The node was deleted or retyped mid-wait: the leaf can never validly complete (409). */
  | ({ ok: false; reason: "node-gone" } & CodedRefusal)
  /** The schema could not be built, or the output does not satisfy it (400, leaf untouched). */
  | ({
      ok: false;
      reason: "output-invalid";
      details?: Extract<OutputValidation, { ok: false }>["issues"];
    } & CodedRefusal);

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
      : resolveNode(args.rootFile, args.workflowDir, args.nodeId, {
          files: args.files,
          operatorConfig: args.operatorConfig,
          env: args.env,
        });
  // The node union is the closed core set; a plugin leaf type is a runtime string outside it.
  if (resolved === undefined || (resolved.node.type as string) !== AWAITING_STEP_TYPE) {
    return {
      ok: false,
      reason: "node-gone",
      ...refusal("run.complete.node-gone", { stepRunId }),
    };
  }

  const rawSchema = (resolved.node as { outputSchema?: JsonValue }).outputSchema;
  if (rawSchema === undefined) return { ok: true };
  let schema: JsonValue;
  try {
    schema = interpolateValue(rawSchema, scopeFor("awaitingSchema", { config: resolved.config }));
  } catch (err) {
    if (!(err instanceof InterpolationError)) throw err;
    return {
      ok: false,
      reason: "output-invalid",
      ...refusal("run.complete.schema-unresolved", { stepRunId, reason: err.message }),
    };
  }
  const validation = validateOutputSchema(schema, args.output);
  if (!validation.ok) {
    return {
      ok: false,
      reason: "output-invalid",
      ...refusal("run.complete.output-invalid", {}),
      details: validation.issues,
    };
  }
  return { ok: true };
}
