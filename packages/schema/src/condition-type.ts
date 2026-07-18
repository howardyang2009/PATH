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
