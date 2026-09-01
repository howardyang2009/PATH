import type { Condition } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  CONDITION_TYPES,
  changeConditionType,
  defaultConditionOfType,
  isLeafConditionType,
  validateCondition,
} from "../src/condition-edit.js";

describe("#370 condition-edit defaults", () => {
  it("mints a structurally-valid condition for every operator", () => {
    for (const type of CONDITION_TYPES) {
      const condition = defaultConditionOfType(type);
      expect(condition.type).toBe(type);
      expect(validateCondition(condition)).toBeNull();
    }
  });

  it("classifies leaves and combinators", () => {
    expect(isLeafConditionType("exists")).toBe(true);
    expect(isLeafConditionType("range")).toBe(true);
    expect(isLeafConditionType("all")).toBe(false);
    expect(isLeafConditionType("not")).toBe(false);
  });
});

describe("#370 changeConditionType carries what the new shape can hold", () => {
  it("keeps the dot-path across a leaf → leaf switch", () => {
    const prev: Condition = { type: "exists", path: "output.result" };
    const next = changeConditionType(prev, "equals");
    expect(next).toMatchObject({ type: "equals", path: "output.result" });
    expect(validateCondition(next)).toBeNull();
  });

  it("wraps a leaf when switching to not, and unwraps back", () => {
    const leaf: Condition = { type: "exists", path: "context.x" };
    const wrapped = changeConditionType(leaf, "not");
    expect(wrapped).toEqual({ type: "not", of: leaf });
    // not → all carries the single child into the list.
    const asAll = changeConditionType(wrapped, "all");
    expect(asAll).toEqual({ type: "all", of: [leaf] });
  });

  it("carries the child list between all and any", () => {
    const all: Condition = { type: "all", of: [{ type: "exists", path: "context.a" }, { type: "exists", path: "context.b" }] };
    const any = changeConditionType(all, "any");
    expect(any).toEqual({ type: "any", of: all.of });
  });

  it("seeds a valid default child when a leaf becomes a combinator with no child to carry", () => {
    const any = changeConditionType({ type: "valid-json", path: "context.x" }, "any");
    expect(any.type).toBe("any");
    expect(validateCondition(any)).toBeNull();
  });
});

describe("#370 validateCondition rejects an ill-typed condition", () => {
  it("flags a bad dot-path root", () => {
    // `config` is not a legal condition root (CONDITION_ROOTS is context/output).
    expect(validateCondition({ type: "exists", path: "config.x" } as Condition)).not.toBeNull();
  });

  it("flags a range with neither bound", () => {
    expect(validateCondition({ type: "range", path: "context.n" } as Condition)).not.toBeNull();
  });
});
