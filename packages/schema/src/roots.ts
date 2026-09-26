/**
 * The root names a `${dot.path}` or a condition path may start from — declared once here (docs/format/workflow-format.md §6).
 */

export const INTERPOLATION_ROOTS = ["config", "context", "output"] as const;
export type InterpolationRoot = (typeof INTERPOLATION_ROOTS)[number];

/** What a step may read before it runs; `output` is absent — its own output does not exist yet. */
export const STEP_ROOTS = ["config", "context"] as const satisfies readonly InterpolationRoot[];

export const PUBLISH_ROOTS = [
  "config",
  "context",
  "output",
] as const satisfies readonly InterpolationRoot[];

/**
 * A condition reads context and the predecessor's output, **not** `config` — a deliberate extension point held open
 * (mvp spec §10).
 */
export const CONDITION_ROOTS = [
  "context",
  "output",
] as const satisfies readonly InterpolationRoot[];
export type ConditionRoot = (typeof CONDITION_ROOTS)[number];
