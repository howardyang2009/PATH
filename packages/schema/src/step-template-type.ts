import type { WorkflowNode } from "./node-type.js";
import type { FORMAT_VERSION } from "./workflow-file-type.js";

/**
 * A `.step-template.json`: a strict, unversioned envelope around a workflow **body** that validates exactly as a
 * file's body does (ADR 0048).
 */
export interface StepTemplate {
  /**
   * The **body** grammar version, not an envelope version: the envelope has no grammar of its own, so this tracks
   * `path/workflow@N`.
   */
  format: typeof FORMAT_VERSION;
  id: string;
  description: string;
  body: WorkflowNode[];
}
