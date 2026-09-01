import { makeWorkflowFileSchema, safeParseWorkflowFileWith, type WorkflowFile } from "@path/schema";
import { scanStepPlugins } from "./plugin/scan.js";

export type ValidateWorkflowFileResult =
  | { success: true; file: WorkflowFile }
  | { success: false; errors: string[] };

/**
 * Validate one workflow file's parsed JSON against `@path/schema`'s `WorkflowFileSchema`, using the
 * *same* plugin registry `loadWorkflowTree` scans (`scanStepPlugins`) so a file with a plugin leaf
 * step (`binary`, `prompt`, …) validates against the grammar that actually exists — but for a single
 * file, with **no** ref resolution, cycle detection, or disk read of nested `workflow` targets.
 *
 * This is what the write door (`PUT /v0/workflows`, server-api-v0.md §7, ADR 0016) needs and
 * `loadWorkflowTree` is wrong for: a saved file may reference a nested `workflow` not yet on disk (a
 * work-in-progress save, or a parent saved before its child). Such a file is schema-valid here and
 * only fails at launch, the "schema-valid does not equal self-sufficient" asymmetry §6 records. The
 * registry scan stays inside the engine, so no consumer rebuilds the freeze `loadWorkflowTree` owns.
 */
export async function validateWorkflowFile(json: unknown): Promise<ValidateWorkflowFileResult> {
  const registry = await scanStepPlugins();
  const parsed = safeParseWorkflowFileWith(makeWorkflowFileSchema(registry), json);
  if (!parsed.success) return { success: false, errors: parsed.errors };
  return { success: true, file: parsed.data };
}
