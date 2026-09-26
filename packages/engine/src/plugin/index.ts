/**
 * `@path/engine/plugin`: the one public subpath a step-type plugin compiles against — it re-exports the engine's own
 * `z` (a plugin must never resolve a second zod, which breaks `instanceof`), the seam types, and `defineStepPlugin`
 * (ADR 0019 sub-5).
 */

export type { JsonValue } from "@path/schema";
export { z } from "zod";
export { resolveAgainstWorkflowDir } from "./resolve-against-workflow-dir.js";
export type { StepPlugin, StepRequest, StepResult, WorkerDescriptor } from "./seam.js";
export { defineStepPlugin } from "./seam.js";
