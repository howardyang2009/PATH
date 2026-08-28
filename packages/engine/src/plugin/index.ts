// `@path/engine/plugin` — the one public subpath a step-type plugin compiles against (ADR 0019 sub-5).
//
// A plugin folder cannot assume a bare `zod` specifier resolves to the engine's copy, and two zod
// instances break the `instanceof` checks the schema factory depends on. So the engine re-exports its
// own `z` here, and the contract is that a plugin takes zod from this subpath — not from `zod`. The
// subpath is separate from the `@path/engine` root deliberately: the root hands out `loadWorkflowTree`,
// `openProject` and `runWorkflow`, none of which a plugin has any business calling (ADR 0019 sub-5).

// The single zod instance a plugin builds its `fields`/`config` fragments from.
export { z } from "zod";

// The identity/typing helper and the seam types a plugin and the engine both compile against.
export { defineStepPlugin } from "./seam.js";
export type { StepPlugin, WorkerDescriptor, StepRequest, StepResult } from "./seam.js";

// #313 sub-14's anchor helper — a worker resolves its own relative paths against `request.cwd`.
export { resolveAgainstWorkflowDir } from "./resolve-against-workflow-dir.js";
