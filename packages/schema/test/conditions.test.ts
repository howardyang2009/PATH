import { describe, expect, it } from "vitest";
import { ConditionSchema } from "../src/conditions.js";

describe("ConditionSchema — leaf predicates", () => {
  it("validates exists", () => {
    expect(ConditionSchema.safeParse({ type: "exists", path: "context.verdict.pass" }).success).toBe(true);
    expect(ConditionSchema.safeParse({ type: "exists" }).success).toBe(false);
  });

  it("validates equals with a scalar value", () => {
    expect(
      ConditionSchema.safeParse({ type: "equals", path: "context.verdict.pass", value: false }).success,
    ).toBe(true);
    expect(
      ConditionSchema.safeParse({
        type: "equals",
        path: "context.verdict.suggested_format",
        value: "short",
      }).success,
    ).toBe(true);
    expect(ConditionSchema.safeParse({ type: "equals", path: "context.x" }).success).toBe(false);
  });

  it("validates one-of with a non-empty values array", () => {
    expect(
      ConditionSchema.safeParse({
        type: "one-of",
        path: "context.verdict.suggested_format",
        values: ["short", "long"],
      }).success,
    ).toBe(true);
    expect(ConditionSchema.safeParse({ type: "one-of", path: "context.x", values: [] }).success).toBe(false);
  });

  it("validates matches with a compileable regex pattern", () => {
    expect(
      ConditionSchema.safeParse({ type: "matches", path: "context.raw_changes", pattern: "\\S" }).success,
    ).toBe(true);
    expect(
      ConditionSchema.safeParse({ type: "matches", path: "context.raw_changes", pattern: "(unclosed" }).success,
    ).toBe(false);
  });

  it("validates range requiring at least min or max", () => {
    expect(ConditionSchema.safeParse({ type: "range", path: "context.n", min: 1 }).success).toBe(true);
    expect(ConditionSchema.safeParse({ type: "range", path: "context.n", max: 10 }).success).toBe(true);
    expect(ConditionSchema.safeParse({ type: "range", path: "context.n", min: 1, max: 10 }).success).toBe(
      true,
    );
    expect(ConditionSchema.safeParse({ type: "range", path: "context.n" }).success).toBe(false);
  });

  it("validates valid-json", () => {
    expect(ConditionSchema.safeParse({ type: "valid-json", path: "context.raw" }).success).toBe(true);
  });

  it("rejects unknown fields on any predicate (strict)", () => {
    expect(
      ConditionSchema.safeParse({ type: "exists", path: "context.x", extra: true }).success,
    ).toBe(false);
  });

  it("rejects a path that does not start with an allowed root", () => {
    expect(ConditionSchema.safeParse({ type: "exists", path: "config.x" }).success).toBe(false);
    expect(ConditionSchema.safeParse({ type: "exists", path: "bogus.x" }).success).toBe(false);
  });

  it("accepts bare-root paths", () => {
    expect(ConditionSchema.safeParse({ type: "exists", path: "context" }).success).toBe(true);
    expect(ConditionSchema.safeParse({ type: "exists", path: "output" }).success).toBe(true);
  });
});

describe("ConditionSchema — combinators", () => {
  it("validates all/any with a non-empty array of sub-conditions", () => {
    const tree = {
      type: "all",
      of: [
        { type: "exists", path: "context.verdict.pass" },
        { type: "one-of", path: "context.verdict.suggested_format", values: ["short", "long"] },
      ],
    };
    expect(ConditionSchema.safeParse(tree).success).toBe(true);
    expect(ConditionSchema.safeParse({ type: "all", of: [] }).success).toBe(false);
    expect(ConditionSchema.safeParse({ type: "any", of: [] }).success).toBe(false);
  });

  it("validates not with a single sub-condition", () => {
    expect(
      ConditionSchema.safeParse({
        type: "not",
        of: { type: "exists", path: "context.x" },
      }).success,
    ).toBe(true);
  });

  it("validates arbitrarily nested combinators", () => {
    const tree = {
      type: "any",
      of: [
        { type: "not", of: { type: "exists", path: "context.x" } },
        {
          type: "all",
          of: [
            { type: "range", path: "context.n", min: 0, max: 10 },
            { type: "matches", path: "context.s", pattern: "^ok$" },
          ],
        },
      ],
    };
    expect(ConditionSchema.safeParse(tree).success).toBe(true);
  });

  it("rejects an unrecognized condition type", () => {
    expect(ConditionSchema.safeParse({ type: "always", path: "context.x" }).success).toBe(false);
  });
});
