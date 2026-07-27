/**
 * The root names a `${dot.path}` or a condition path may start from — declared once, here.
 *
 * Each set below was previously written inline wherever it was needed: five literal
 * `["config", "context"]`-shaped arrays across `nodes.ts`, `worker.ts`, `workflow-file.ts` and
 * `interpolation.ts`, plus a private `CONDITION_ROOTS` in `conditions.ts` that the engine then
 * re-derived as a hardcoded pair. Which roots are legal *where* is a rule of the format, so it is
 * stated once and referenced.
 */

/** Every root the interpolation grammar knows (workflow-format-v0.md §5). */
export const INTERPOLATION_ROOTS = ["config", "context", "output"] as const;
export type InterpolationRoot = (typeof INTERPOLATION_ROOTS)[number];

/**
 * What a step may read *before* it runs: its config and the workflow-run's context. `output` is
 * absent because a step's own output does not exist yet at the point its input is resolved.
 */
export const STEP_ROOTS = ["config", "context"] as const satisfies readonly InterpolationRoot[];

/**
 * What a `publish` expression may read: everything a step could read, plus the `output` the step
 * just produced — which is the point of publishing (format §6.2).
 */
export const PUBLISH_ROOTS = ["config", "context", "output"] as const satisfies readonly InterpolationRoot[];

/**
 * What a condition may read (format §9): the workflow-run's context, and the predecessor node's
 * output object. Notably **not** `config` — that is a deliberate extension point held open in the
 * deferred register (mvp spec §10, "config as a condition root — additive third root").
 */
export const CONDITION_ROOTS = ["context", "output"] as const satisfies readonly InterpolationRoot[];
export type ConditionRoot = (typeof CONDITION_ROOTS)[number];
