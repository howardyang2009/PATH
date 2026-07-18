import { describe, expect, it } from "vitest";
import { checkInterpolationSyntax, interpolableString, interpolatedJsonValue } from "../src/interpolation.js";

describe("checkInterpolationSyntax", () => {
  it("accepts a plain literal string with no placeholders", () => {
    expect(checkInterpolationSyntax("just some text", ["config", "context"])).toEqual({ ok: true });
  });

  it("accepts a whole-string single placeholder", () => {
    expect(checkInterpolationSyntax("${context.foo}", ["config", "context"])).toEqual({ ok: true });
  });

  it("accepts a bare root placeholder", () => {
    expect(checkInterpolationSyntax("${output}", ["output"])).toEqual({ ok: true });
  });

  it("accepts a splice of literal text and placeholders", () => {
    expect(checkInterpolationSyntax("Hello ${context.name}!", ["config", "context"])).toEqual({ ok: true });
    expect(checkInterpolationSyntax("${context.a}-${context.b}", ["config", "context"])).toEqual({ ok: true });
  });

  it("accepts numeric segments as array indices", () => {
    expect(checkInterpolationSyntax("${context.items.0.name}", ["config", "context"])).toEqual({ ok: true });
  });

  it("treats $${ as an escaped literal ${ and does not parse a placeholder", () => {
    expect(checkInterpolationSyntax("cost is $${100} exactly", ["config", "context"])).toEqual({ ok: true });
  });

  it("rejects an unclosed placeholder", () => {
    const result = checkInterpolationSyntax("${config.a", ["config", "context"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unclosed/i);
  });

  it("rejects an empty placeholder", () => {
    const result = checkInterpolationSyntax("${}", ["config", "context"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });

  it("rejects a disallowed root", () => {
    const result = checkInterpolationSyntax("${output.x}", ["config", "context"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/root/i);
    expect(result.error).toMatch(/output/);
  });

  it("rejects an unknown root", () => {
    const result = checkInterpolationSyntax("${bogus.x}", ["config", "context"]);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed dot-path syntax", () => {
    for (const bad of ["${context.foo bar}", "${context..a}", "${context.}", "${.context}"]) {
      const result = checkInterpolationSyntax(bad, ["config", "context"]);
      expect(result.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("rejects splicing that would need to stringify a placeholder next to another dollar sign edge case gracefully", () => {
    // Not a real edge case from the spec, just confirms literal `$` not followed by `{` is inert text.
    expect(checkInterpolationSyntax("price: $5", ["config", "context"])).toEqual({ ok: true });
  });
});

describe("interpolableString", () => {
  it("accepts valid interpolation strings", () => {
    const schema = interpolableString(["config", "context"]);
    expect(schema.safeParse("${context.raw_changes}").success).toBe(true);
    expect(schema.safeParse("plain text").success).toBe(true);
  });

  it("rejects invalid interpolation strings", () => {
    const schema = interpolableString(["config", "context"]);
    expect(schema.safeParse("${output.x}").success).toBe(false);
    expect(schema.safeParse("${}").success).toBe(false);
  });

  it("rejects non-string input", () => {
    const schema = interpolableString(["config", "context"]);
    expect(schema.safeParse(42).success).toBe(false);
  });
});

describe("interpolatedJsonValue", () => {
  it("accepts scalars and null", () => {
    const schema = interpolatedJsonValue(["config", "context"]);
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse("${context.x}").success).toBe(true);
  });

  it("recurses through arrays and objects, validating every string leaf", () => {
    const schema = interpolatedJsonValue(["config", "context"]);
    expect(
      schema.safeParse({
        a: ["${context.x}", "literal", 3],
        b: { c: "${config.y}" },
      }).success,
    ).toBe(true);

    expect(
      schema.safeParse({
        a: ["${output.x}"],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed placeholders nested deep in the structure", () => {
    const schema = interpolatedJsonValue(["config", "context"]);
    expect(schema.safeParse({ a: { b: { c: "${config.}" } } }).success).toBe(false);
  });
});
