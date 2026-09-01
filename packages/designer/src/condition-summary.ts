import type { Condition, JsonScalar } from "@path/schema";

/**
 * A one-line, read-only plain-text summary of a structured `Condition` (designer-spec § Structure on
 * the canvas, content in the pane): the text the canvas shows on a branch arm's `when`, a `while-do`'s
 * `condition`, and a `checkpoint`'s `assert`. It is a *summary*, never an editor — the typed condition
 * builder is a later ticket (§ Still open). The output favours legibility over round-trip fidelity: it
 * reads like the predicate, not like the JSON.
 */
export function summarizeCondition(condition: Condition): string {
  switch (condition.type) {
    case "exists":
      return `exists ${condition.path}`;
    case "equals":
      return `${condition.path} == ${scalar(condition.value)}`;
    case "one-of":
      return `${condition.path} in [${condition.values.map(scalar).join(", ")}]`;
    case "matches":
      return `${condition.path} ~ /${condition.pattern}/`;
    case "range":
      return `${condition.path} in ${bound(condition.min)}..${bound(condition.max)}`;
    case "valid-json":
      return `valid-json ${condition.path}`;
    case "all":
      return condition.of.length === 0 ? "true" : `(${condition.of.map(summarizeCondition).join(" and ")})`;
    case "any":
      return condition.of.length === 0 ? "false" : `(${condition.of.map(summarizeCondition).join(" or ")})`;
    case "not":
      return `not ${summarizeCondition(condition.of)}`;
  }
}

/** A scalar operand rendered compactly: a string keeps its quotes so it is told from a bare path or number. */
function scalar(value: JsonScalar): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** One end of a `range`, or `*` when that end is unbounded. */
function bound(value: number | undefined): string {
  return value === undefined ? "*" : String(value);
}
