import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";

/** The root names a `${dot.path}` or a condition path may start from (workflow-format.md §6). */
export const INTERPOLATION_ROOTS = ["config", "context", "output", "previous"] as const;
export type InterpolationRoot = (typeof INTERPOLATION_ROOTS)[number];

/** The step type whose leaf parks for a person until Complete (ADR 0039). */
export const AWAITING_STEP_TYPE = "person-activity";

/**
 * Every position a `${}` or a condition path is read in, and the roots it may name. The load, the
 * engine's scopes and the Designer's editors all read this one table (ADR 0079).
 * - `previous` is the output of the node that ran just before; `output` is a step's own output, so
 *   only `publish` reads it.
 * - A condition reads no `config`: an extension point held open (mvp spec §10).
 * - An awaiting step's `outputSchema` is resolved again at Complete, where only `config` exists
 *   (ADR 0040).
 */
export const ROOTS = {
  input: ["config", "context", "previous"],
  publish: ["config", "context", "output"],
  condition: ["context", "previous"],
  typeField: ["config", "context"],
  awaitingSchema: ["config"],
  limit: ["config", "context"],
  fileOutput: ["config", "context"],
} as const satisfies Record<string, readonly InterpolationRoot[]>;

export type RootPosition = keyof typeof ROOTS;
export type ConditionRoot = (typeof ROOTS.condition)[number];

/** The values a position's expressions resolve against: exactly its roots, each required. `limit`
 * is a `while-do`'s `max_iterations` or a `goto`'s `max_jumps`. */
export type ScopeFor<P extends RootPosition> = {
  [R in (typeof ROOTS)[P][number]]: R extends "config" ? ConfigObject : JsonValue;
};

/** The roots a step type's own field reads. Every type field is interpolated at run start, except
 * an awaiting step's `outputSchema`, which Complete resolves again. */
export function typeFieldRoots(typeName: string, fieldName: string): readonly InterpolationRoot[] {
  return typeName === AWAITING_STEP_TYPE && fieldName === "outputSchema"
    ? ROOTS.awaitingSchema
    : ROOTS.typeField;
}

/** The positions a node of `type` itself carries: a control block's own fields, or a step's
 * envelope plus its type fields. A branch arm's `when` belongs to the arm, not to either node. */
export function nodePositions(type: string): RootPosition[] {
  switch (type) {
    case "while-do":
      return ["condition", "limit"];
    case "goto":
      return ["limit"];
    case "checkpoint":
      return ["condition"];
    case "parallel":
    case "branch":
    case "sequence":
      return [];
    default:
      return ["input", "publish", "typeField"];
  }
}
