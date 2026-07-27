import { describe, expect, it } from "vitest";
import {
  InterpolationError,
  interpolateString,
  interpolateToString,
  interpolateValue,
  resolveDotPath,
} from "../src/interpolate.js";

describe("resolveDotPath", () => {
  const scope = {
    config: { model: "opus", nested: { deep: 42 } },
    context: { items: ["a", "b", "c"], flag: true, empty: null },
  };

  it("resolves a bare root", () => {
    expect(resolveDotPath(scope, "config")).toEqual(scope.config);
  });

  it("resolves a nested object path", () => {
    expect(resolveDotPath(scope, "config.nested.deep")).toBe(42);
  });

  it("resolves a numeric array index", () => {
    expect(resolveDotPath(scope, "context.items.1")).toBe("b");
  });

  it("resolves booleans and null", () => {
    expect(resolveDotPath(scope, "context.flag")).toBe(true);
    expect(resolveDotPath(scope, "context.empty")).toBe(null);
  });

  it("throws on an unknown root", () => {
    expect(() => resolveDotPath(scope, "output.x")).toThrow(InterpolationError);
  });

  it("throws on a missing key", () => {
    expect(() => resolveDotPath(scope, "config.nope")).toThrow(InterpolationError);
  });

  it("throws on an out-of-bounds array index", () => {
    expect(() => resolveDotPath(scope, "context.items.9")).toThrow(InterpolationError);
  });

  it("throws when indexing into a scalar", () => {
    expect(() => resolveDotPath(scope, "context.flag.x")).toThrow(InterpolationError);
  });

  it("transparently unwraps a $secret config value to its real string", () => {
    const withSecret = { config: { token: { $secret: "sk-real-value" } }, context: {} };
    expect(resolveDotPath(withSecret, "config.token")).toBe("sk-real-value");
  });

  it("unwraps a $secret value nested inside a returned sub-tree, not just at the exact leaf addressed", () => {
    const withNestedSecret = {
      config: { auth: { token: { $secret: "sk-nested" }, plain: "ok" } },
      context: {},
    };
    expect(resolveDotPath(withNestedSecret, "config.auth")).toEqual({ token: "sk-nested", plain: "ok" });
    expect(resolveDotPath(withNestedSecret, "config")).toEqual({
      auth: { token: "sk-nested", plain: "ok" },
    });
  });

  it("unwraps a $secret value nested inside an array element of a returned sub-tree", () => {
    const withSecretInArray = { config: { tokens: [{ $secret: "sk-1" }, "plain"] }, context: {} };
    expect(resolveDotPath(withSecretInArray, "config.tokens")).toEqual(["sk-1", "plain"]);
  });
});

describe("interpolateString", () => {
  const scope = {
    config: { max: 3, name: "path" },
    context: { count: 5, items: ["x", "y"] },
  };

  it("preserves real type for a whole-string placeholder", () => {
    expect(interpolateString("${config.max}", scope)).toBe(3);
  });

  it("stringifies scalars when splicing into surrounding text", () => {
    expect(interpolateString("Hello ${config.name}!", scope)).toBe("Hello path!");
    expect(interpolateString("count=${context.count}", scope)).toBe("count=5");
  });

  it("splices multiple placeholders", () => {
    expect(interpolateString("${context.items.0}-${context.items.1}", scope)).toBe("x-y");
  });

  it("treats an escaped $${ as literal text, never resolving it", () => {
    expect(interpolateString("cost is $${100} exactly", scope)).toBe("cost is ${100} exactly");
  });

  it("leaves a string with no placeholders untouched", () => {
    expect(interpolateString("just text", scope)).toBe("just text");
  });

  it("throws when splicing a non-scalar (object/array) value", () => {
    const objScope = { config: {}, context: { obj: { a: 1 } } };
    expect(() => interpolateString("value: ${context.obj}", objScope)).toThrow(InterpolationError);
  });

  it("allows a whole-string placeholder to resolve to a non-scalar (object/array)", () => {
    const objScope = { config: {}, context: { obj: { a: 1 } } };
    expect(interpolateString("${context.obj}", objScope)).toEqual({ a: 1 });
  });

  it("throws on an unresolvable path", () => {
    expect(() => interpolateString("${context.missing}", scope)).toThrow(InterpolationError);
  });

  /**
   * The failure the old implementation could not see (#68). Substitution scanned for `}` itself
   * and assumed one existed, because load-time validation would have rejected the string —
   * `const close = value.indexOf("}", i + 2); // close exists`. Nothing enforced that ordering, so
   * a string arriving here unvalidated yielded `close === -1`, `slice(i + 2, -1)`, and a silently
   * truncated substitution. The grammar is @path/schema's now, and `unclosed` is a token.
   */
  it("throws on an unclosed placeholder rather than silently truncating it", () => {
    expect(() => interpolateString("${config.name", scope)).toThrow(InterpolationError);
    expect(() => interpolateString("${config.name", scope)).toThrow(/unclosed placeholder starting at index 0/);
  });

  it("throws on an unclosed placeholder that follows a valid one", () => {
    expect(() => interpolateString("${config.name} then ${config.na", scope)).toThrow(
      /unclosed placeholder starting at index 20/,
    );
  });

  it("leaves a bare $ and a $${ escape alone while substituting the rest", () => {
    expect(interpolateString("$5 $${literal} ${config.name}", scope)).toBe("$5 ${literal} path");
  });
});

describe("interpolateToString", () => {
  const scope = { config: { count: 3, flag: true }, context: { obj: { a: 1 } } };

  it("passes through a plain string", () => {
    expect(interpolateToString("plain", scope)).toBe("plain");
  });

  it("stringifies a whole-string placeholder that resolves to a scalar", () => {
    expect(interpolateToString("${config.count}", scope)).toBe("3");
    expect(interpolateToString("${config.flag}", scope)).toBe("true");
  });

  it("throws when a whole-string placeholder resolves to a non-scalar", () => {
    expect(() => interpolateToString("${context.obj}", scope)).toThrow(InterpolationError);
  });
});

describe("interpolateValue", () => {
  const scope = { config: { x: 1 }, context: { y: "hi" } };

  it("passes non-string scalars through unchanged", () => {
    expect(interpolateValue(42, scope)).toBe(42);
    expect(interpolateValue(true, scope)).toBe(true);
    expect(interpolateValue(null, scope)).toBe(null);
  });

  it("recurses through arrays", () => {
    expect(interpolateValue(["${config.x}", "literal", "${context.y}"], scope)).toEqual([1, "literal", "hi"]);
  });

  it("recurses through nested objects", () => {
    expect(interpolateValue({ a: "${config.x}", b: { c: "${context.y}" } }, scope)).toEqual({
      a: 1,
      b: { c: "hi" },
    });
  });
});
