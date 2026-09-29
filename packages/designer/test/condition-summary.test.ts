import type { Condition } from "@path/schema";
import { describe, expect, it } from "vitest";
import { summarizeCondition } from "../src/condition-summary.js";

describe("summarizeCondition", () => {
  it("renders each leaf predicate compactly", () => {
    expect(summarizeCondition({ type: "exists", path: "context.x" })).toBe("exists context.x");
    expect(summarizeCondition({ type: "equals", path: "previous.n", value: 3 })).toBe(
      "previous.n == 3",
    );
    expect(summarizeCondition({ type: "equals", path: "previous.s", value: "ok" })).toBe(
      'previous.s == "ok"',
    );
    expect(summarizeCondition({ type: "one-of", path: "context.k", values: ["a", "b"] })).toBe(
      'context.k in ["a", "b"]',
    );
    expect(summarizeCondition({ type: "matches", path: "previous.v", pattern: "^v" })).toBe(
      "previous.v ~ /^v/",
    );
    expect(summarizeCondition({ type: "range", path: "previous.n", min: 1, max: 9 })).toBe(
      "previous.n in 1..9",
    );
    expect(summarizeCondition({ type: "range", path: "previous.n", min: 1 })).toBe(
      "previous.n in 1..*",
    );
    expect(summarizeCondition({ type: "valid-json", path: "previous.raw" })).toBe(
      "valid-json previous.raw",
    );
  });

  it("composes all/any/not", () => {
    const cond: Condition = {
      type: "all",
      of: [
        { type: "exists", path: "context.a" },
        { type: "not", of: { type: "exists", path: "context.b" } },
      ],
    };
    expect(summarizeCondition(cond)).toBe("(exists context.a and not exists context.b)");
    expect(summarizeCondition({ type: "any", of: [{ type: "exists", path: "x" }] })).toBe(
      "(exists x)",
    );
  });
});
