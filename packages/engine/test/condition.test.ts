import type { Condition } from "@path/schema";
import { describe, expect, it } from "vitest";
import { describeConditionFailure, evaluateCondition, TraceSchema, type ConditionRoots } from "../src/condition.js";

const roots: ConditionRoots = {
  context: {
    name: "alice",
    count: 5,
    ok: true,
    payload: '{"a":1}',
    bad: "not json",
    tags: ["red", "green"],
    nested: { level: 2 },
    nothing: null,
  },
  output: { status: "done" },
};

function evalCond(condition: Condition) {
  return evaluateCondition(condition, roots);
}

describe("evaluateCondition — leaf predicates over strict semantics (ticket #21)", () => {
  it("exists is true when the path resolves and false (not error) when it does not", () => {
    expect(evalCond({ type: "exists", path: "context.name" }).outcome).toBe("true");
    const missing = evalCond({ type: "exists", path: "context.absent" });
    expect(missing.outcome).toBe("false");
    expect(missing.trace).toMatchObject({ type: "exists", path: "context.absent", outcome: "false" });
  });

  it("exists treats a resolved null as present (true) — presence, not truthiness", () => {
    expect(evalCond({ type: "exists", path: "context.nothing" }).outcome).toBe("true");
  });

  it("equals compares to a scalar and records the actual value read", () => {
    const hit = evalCond({ type: "equals", path: "context.count", value: 5 });
    expect(hit.outcome).toBe("true");
    expect(hit.trace).toMatchObject({ outcome: "true", value: 5 });
    expect(evalCond({ type: "equals", path: "context.count", value: 6 }).outcome).toBe("false");
  });

  it("one-of is true when the value is in the set", () => {
    expect(evalCond({ type: "one-of", path: "context.name", values: ["bob", "alice"] }).outcome).toBe("true");
    expect(evalCond({ type: "one-of", path: "context.name", values: ["bob"] }).outcome).toBe("false");
  });

  it("matches tests a regex against a string value", () => {
    expect(evalCond({ type: "matches", path: "context.name", pattern: "^al" }).outcome).toBe("true");
    expect(evalCond({ type: "matches", path: "context.name", pattern: "^zz" }).outcome).toBe("false");
  });

  it("range honors min and max bounds", () => {
    expect(evalCond({ type: "range", path: "context.count", min: 1, max: 10 }).outcome).toBe("true");
    expect(evalCond({ type: "range", path: "context.count", min: 6 }).outcome).toBe("false");
    expect(evalCond({ type: "range", path: "context.count", max: 4 }).outcome).toBe("false");
  });

  it("valid-json is true for a parseable string, false for an unparseable one", () => {
    expect(evalCond({ type: "valid-json", path: "context.payload" }).outcome).toBe("true");
    expect(evalCond({ type: "valid-json", path: "context.bad" }).outcome).toBe("false");
  });
});

describe("evaluateCondition — strict error semantics (ticket #21)", () => {
  it("an unresolvable path is an error leaf for value-reading predicates", () => {
    const result = evalCond({ type: "equals", path: "context.absent", value: 1 });
    expect(result.outcome).toBe("error");
    expect(result.trace).toMatchObject({ type: "equals", path: "context.absent", outcome: "error" });
    expect((result.trace as { message?: string }).message).toMatch(/does not resolve/);
  });

  it("a type mismatch is an error (matches on a non-string, range on a non-number)", () => {
    expect(evalCond({ type: "matches", path: "context.count", pattern: "5" }).outcome).toBe("error");
    expect(evalCond({ type: "range", path: "context.name", min: 0 }).outcome).toBe("error");
    expect(evalCond({ type: "valid-json", path: "context.count" }).outcome).toBe("error");
  });
});

describe("evaluateCondition — combinators (ticket #21)", () => {
  it("all is true only when every child is true, and mirrors the tree in the trace", () => {
    const result = evalCond({
      type: "all",
      of: [
        { type: "exists", path: "context.name" },
        { type: "equals", path: "context.count", value: 5 },
      ],
    });
    expect(result.outcome).toBe("true");
    expect(result.trace).toMatchObject({ type: "all", outcome: "true" });
    expect((result.trace as { of: unknown[] }).of).toHaveLength(2);
  });

  it("any is true when at least one child is true", () => {
    expect(
      evalCond({ type: "any", of: [{ type: "equals", path: "context.count", value: 99 }, { type: "exists", path: "context.name" }] })
        .outcome,
    ).toBe("true");
  });

  it("not inverts a true/false child", () => {
    expect(evalCond({ type: "not", of: { type: "exists", path: "context.name" } }).outcome).toBe("false");
    expect(evalCond({ type: "not", of: { type: "exists", path: "context.absent" } }).outcome).toBe("true");
  });

  it("an error child dominates: all/any/not of an error are themselves error", () => {
    const errChild: Condition = { type: "range", path: "context.name", min: 0 };
    expect(evalCond({ type: "all", of: [{ type: "exists", path: "context.name" }, errChild] }).outcome).toBe("error");
    expect(evalCond({ type: "any", of: [{ type: "exists", path: "context.name" }, errChild] }).outcome).toBe("error");
    expect(evalCond({ type: "not", of: errChild }).outcome).toBe("error");
  });
});

describe("evaluateCondition — trace shape and helpers (ticket #21)", () => {
  it("every produced trace validates against TraceSchema", () => {
    const condition: Condition = {
      type: "all",
      of: [
        { type: "not", of: { type: "exists", path: "context.absent" } },
        { type: "any", of: [{ type: "matches", path: "context.name", pattern: "^al" }] },
      ],
    };
    expect(() => TraceSchema.parse(evalCond(condition).trace)).not.toThrow();
  });

  it("describeConditionFailure surfaces the first error message, else the first false", () => {
    const errTrace = evalCond({ type: "range", path: "context.name", min: 0 }).trace;
    expect(describeConditionFailure(errTrace)).toMatch(/requires a number/);
    const falseTrace = evalCond({ type: "equals", path: "context.count", value: 6 }).trace;
    expect(describeConditionFailure(falseTrace)).toMatch(/was false|context.count/);
  });
});
