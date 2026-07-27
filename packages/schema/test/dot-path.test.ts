import { describe, expect, it } from "vitest";
import { checkDotPath, resolveDotPath } from "../src/dot-path.js";
import { CONDITION_ROOTS } from "../src/roots.js";

/**
 * The walk used to exist twice in `@path/engine` — once returning a result for the condition
 * evaluator, once throwing for interpolation — with the same algorithm and different wording for
 * identical failures (#68). It is one implementation now, and it lives beside the syntax check that
 * governs the same grammar.
 */

const roots = {
  context: { name: "ada", nested: { deep: [10, 20] }, flag: false, nothing: null },
  output: "a string",
};

describe("resolveDotPath", () => {
  it("resolves a bare root", () => {
    expect(resolveDotPath(roots, "output")).toEqual({ found: true, value: "a string" });
  });

  it("walks object segments", () => {
    expect(resolveDotPath(roots, "context.name")).toEqual({ found: true, value: "ada" });
    expect(resolveDotPath(roots, "context.nested.deep")).toEqual({ found: true, value: [10, 20] });
  });

  it("indexes arrays by numeric segment", () => {
    expect(resolveDotPath(roots, "context.nested.deep.1")).toEqual({ found: true, value: 20 });
  });

  it("resolves falsy values rather than treating them as absent", () => {
    expect(resolveDotPath(roots, "context.flag")).toEqual({ found: true, value: false });
    expect(resolveDotPath(roots, "context.nothing")).toEqual({ found: true, value: null });
  });

  it("reports an unknown root", () => {
    expect(resolveDotPath(roots, "config.anything")).toEqual({ found: false, error: 'unknown root "config"' });
  });

  it("reports a missing key, an out-of-bounds index, and a walk into a non-object", () => {
    expect(resolveDotPath(roots, "context.nope")).toEqual({ found: false, error: 'key "nope" not found' });
    expect(resolveDotPath(roots, "context.nested.deep.9")).toEqual({
      found: false,
      error: 'index "9" is out of bounds',
    });
    expect(resolveDotPath(roots, "output.x")).toEqual({
      found: false,
      error: '"x" reaches into a non-object value',
    });
  });

  it("does not resolve inherited properties", () => {
    expect(resolveDotPath(roots, "context.toString")).toEqual({ found: false, error: 'key "toString" not found' });
  });

  // `error` names the segment, never the whole path: the caller already knows the path and frames
  // the failure its own way — a trace leaf, or a thrown InterpolationError.
  it("names the segment that stopped the walk, not the path", () => {
    const result = resolveDotPath(roots, "context.nested.missing");
    expect(result.found).toBe(false);
    if (result.found) throw new Error("expected a failure");
    expect(result.error).not.toContain("context.nested.missing");
  });
});

describe("checkDotPath and resolveDotPath govern the same grammar", () => {
  it("accepts the roots the condition language declares", () => {
    for (const root of CONDITION_ROOTS) {
      expect(checkDotPath(root, CONDITION_ROOTS).ok).toBe(true);
      expect(resolveDotPath(roots, root).found).toBe(true);
    }
  });
});
