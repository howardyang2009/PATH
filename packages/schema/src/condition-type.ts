export type JsonScalar = string | number | boolean | null;

export interface ExistsCondition {
  type: "exists";
  path: string;
}

export interface EqualsCondition {
  type: "equals";
  path: string;
  value: JsonScalar;
}

export interface OneOfCondition {
  type: "one-of";
  path: string;
  values: JsonScalar[];
}

export interface MatchesCondition {
  type: "matches";
  path: string;
  pattern: string;
}

export interface RangeCondition {
  type: "range";
  path: string;
  min?: number;
  max?: number;
}

export interface ValidJsonCondition {
  type: "valid-json";
  path: string;
}

export interface AllCondition {
  type: "all";
  of: Condition[];
}

export interface AnyCondition {
  type: "any";
  of: Condition[];
}

export interface NotCondition {
  type: "not";
  of: Condition;
}

export type Condition =
  | ExistsCondition
  | EqualsCondition
  | OneOfCondition
  | MatchesCondition
  | RangeCondition
  | ValidJsonCondition
  | AllCondition
  | AnyCondition
  | NotCondition;

/**
 * A leaf predicate — one that reads a value at a `path`, as opposed to the `all`/`any`/`not`
 * combinators that only compose other conditions.
 */
export type LeafCondition = Extract<Condition, { path: string }>;
export type LeafConditionType = LeafCondition["type"];

/**
 * The leaf operator names at runtime. `satisfies` ties it to the union above and the exhaustiveness
 * check below ties it the other way, so the list cannot drift from the types in either direction —
 * which is the whole reason it exists rather than being written out wherever an enum is needed.
 */
export const LEAF_CONDITION_TYPES = [
  "exists",
  "equals",
  "one-of",
  "matches",
  "range",
  "valid-json",
] as const satisfies readonly LeafConditionType[];

// Fails to compile if the union grows a leaf operator the list above is missing.
type _ExhaustiveLeafTypes = Exclude<LeafConditionType, (typeof LEAF_CONDITION_TYPES)[number]> extends never
  ? true
  : ["LEAF_CONDITION_TYPES is missing", Exclude<LeafConditionType, (typeof LEAF_CONDITION_TYPES)[number]>];
