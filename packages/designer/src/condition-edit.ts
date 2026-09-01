import { ConditionSchema, LEAF_CONDITION_TYPES, type Condition, type JsonScalar } from "@path/schema";

/**
 * The pure edit vocabulary the typed `Condition` builder is built on (#370, designer-spec § Canvas
 * interaction model, ADR 0022). The builder edits the structured `Condition` AST — never free text — so
 * an ill-typed or unparseable condition is *unrepresentable*, the structural analogue of the unsnappable
 * socket. This module owns the two things the builder cannot express as plain React state: a valid
 * default for each operator, and the operator-switch that carries what it can from the previous shape.
 *
 * A condition governs a branch arm's `when`, a `while-do`'s `condition`, and a `checkpoint`'s assertion
 * (§ Per-kind rendering). The builder commits a sub-condition only when the whole condition validates
 * (`validateCondition`), so a half-typed dot-path never reaches the file — the node stays strict-valid,
 * exactly as the raw-JSON floor keeps a leaf strict-valid (#369).
 */

/** The three combinators — the operators that compose other conditions rather than reading a `path`. */
export const COMBINATOR_CONDITION_TYPES = ["all", "any", "not"] as const;

/** Every operator a builder row offers, leaves first then combinators, in the menu order the pane shows. */
export const CONDITION_TYPES: readonly Condition["type"][] = [...LEAF_CONDITION_TYPES, ...COMBINATOR_CONDITION_TYPES];

/** True for a leaf predicate (one that reads a `path`), false for a combinator (`all` / `any` / `not`). */
export function isLeafConditionType(type: Condition["type"]): boolean {
  return (LEAF_CONDITION_TYPES as readonly string[]).includes(type);
}

/** The default dot-path a fresh leaf predicate reads — matching the node factory's placeholder (#368). */
const DEFAULT_PATH = "context.value";

/** A fresh, valid leaf predicate — the seed for a new combinator child and the fallback default. */
function defaultLeaf(): Condition {
  return { type: "exists", path: DEFAULT_PATH };
}

/** The JSON-scalar kind of a value, for the `equals` operand's typed editor. */
export type ScalarKind = "string" | "number" | "boolean" | "null";

/** The scalar kind of a `JsonScalar`, so the operand editor can pre-select its type control. */
export function scalarKind(value: JsonScalar): ScalarKind {
  if (value === null) return "null";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/** A valid default value for a scalar kind, when the operand's type control switches kind. */
export function defaultScalar(kind: ScalarKind): JsonScalar {
  switch (kind) {
    case "number":
      return 0;
    case "boolean":
      return true;
    case "null":
      return null;
    case "string":
      return "";
  }
}

/** A fresh, structurally-valid condition of `type` — every operand slot filled with a valid default. */
export function defaultConditionOfType(type: Condition["type"]): Condition {
  switch (type) {
    case "exists":
      return { type: "exists", path: DEFAULT_PATH };
    case "equals":
      return { type: "equals", path: DEFAULT_PATH, value: "" };
    case "one-of":
      return { type: "one-of", path: DEFAULT_PATH, values: [""] };
    case "matches":
      return { type: "matches", path: DEFAULT_PATH, pattern: "" };
    case "range":
      return { type: "range", path: DEFAULT_PATH, min: 0 };
    case "valid-json":
      return { type: "valid-json", path: DEFAULT_PATH };
    case "all":
      return { type: "all", of: [defaultLeaf()] };
    case "any":
      return { type: "any", of: [defaultLeaf()] };
    case "not":
      return { type: "not", of: defaultLeaf() };
  }
}

/** The dot-path a leaf predicate reads, or `undefined` for a combinator that reads none. */
function pathOf(condition: Condition): string | undefined {
  return "path" in condition ? condition.path : undefined;
}

/**
 * Switch a condition's operator, carrying what the new shape can hold from the old:
 * - **leaf → leaf** keeps the dot-path (the operand the author already chose to read).
 * - **→ `all` / `any`** keeps the child list when the previous was itself an `all`/`any`, else seeds one.
 * - **→ `not`** keeps the single child when the previous was a `not`, else seeds one.
 *
 * The result is always a structurally-valid default of the new type, so the switch itself can never
 * make a condition unrepresentable.
 */
export function changeConditionType(prev: Condition, next: Condition["type"]): Condition {
  if (next === prev.type) return prev;

  if (isLeafConditionType(next)) {
    const base = defaultConditionOfType(next);
    const path = pathOf(prev);
    return path === undefined ? base : ({ ...base, path } as Condition);
  }

  if (next === "not") {
    if (prev.type === "not") return prev;
    return { type: "not", of: prev.type === "all" || prev.type === "any" ? (prev.of[0] ?? defaultLeaf()) : prev };
  }

  // `all` / `any`: carry the child list from another combinator, else wrap/seed.
  const combinator = next as "all" | "any";
  if (prev.type === "all" || prev.type === "any") return { type: combinator, of: prev.of };
  if (prev.type === "not") return { type: combinator, of: [prev.of] };
  return { type: combinator, of: [defaultLeaf()] };
}

/** Validate a whole condition against the schema; returns the first issue message, or `null` when valid. */
export function validateCondition(condition: Condition): string | null {
  const result = ConditionSchema.safeParse(condition);
  return result.success ? null : (result.error.issues[0]?.message ?? "invalid condition");
}
