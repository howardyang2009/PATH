import { makeWorkflowFileSchema, safeParseWorkflowFileWith, type WorkflowFile } from "@path/schema";
import { scanStepPlugins } from "./plugin/scan.js";

export type ValidateWorkflowFileResult =
  | { success: true; file: WorkflowFile }
  | { success: false; errors: string[] };

/** Validates one file's parsed JSON against the plugin-aware schema, with **no** ref resolution or
 * disk read of nested targets — a work-in-progress save may name a child not yet written. */
export async function validateWorkflowFile(json: unknown): Promise<ValidateWorkflowFileResult> {
  const registry = await scanStepPlugins();
  const parsed = safeParseWorkflowFileWith(makeWorkflowFileSchema(registry), json);
  if (!parsed.success) return { success: false, errors: parsed.errors };
  return { success: true, file: parsed.data };
}
