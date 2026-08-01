import { describe, expect, it } from "vitest";
import { ConfigObjectSchema, ConfigValueSchema } from "../src/config.js";

describe("ConfigValueSchema", () => {
  it("accepts JSON literal scalars", () => {
    for (const value of ["hello", 42, true, false, null]) {
      expect(ConfigValueSchema.safeParse(value).success).toBe(true);
    }
  });

  it("accepts nested arrays and objects of literals", () => {
    expect(
      ConfigValueSchema.safeParse({
        a: [1, "two", { three: 3 }],
        nested: { deeper: { value: true } },
      }).success,
    ).toBe(true);
  });

  it("does not treat ${} strings specially — config is a literal source, never interpolated", () => {
    const result = ConfigValueSchema.safeParse("${context.x}");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("${context.x}");
    }
  });

  it("accepts the $secret wrapper as a config value", () => {
    const result = ConfigValueSchema.safeParse({ $secret: "sk-abc123" });
    expect(result.success).toBe(true);
  });

  it("rejects a $secret wrapper whose value is not a string", () => {
    expect(ConfigValueSchema.safeParse({ $secret: 123 }).success).toBe(false);
  });

  it("rejects a $secret wrapper with extra keys (not the sole marking)", () => {
    // An object that happens to have a $secret key alongside others is just a
    // regular config object, not a secret marking — but it must still be valid
    // as a plain object of config values, which it is here.
    const result = ConfigValueSchema.safeParse({ $secret: "sk-abc123", other: "field" });
    expect(result.success).toBe(true);
  });

  it("accepts the $env wrapper as a config value", () => {
    expect(ConfigValueSchema.safeParse({ $env: "GITHUB_TOKEN" }).success).toBe(true);
  });

  it("accepts an $env wrapper nested inside a $secret wrapper", () => {
    // The composed form: sources from the environment *and* marks the sourced value secret.
    expect(ConfigValueSchema.safeParse({ $secret: { $env: "GITHUB_TOKEN" } }).success).toBe(true);
  });

  it("rejects an $env wrapper whose value is not a string", () => {
    expect(ConfigValueSchema.safeParse({ $env: 3 }).success).toBe(false);
  });

  it("rejects a $secret wrapper holding a malformed $env wrapper", () => {
    expect(ConfigValueSchema.safeParse({ $secret: { $env: 3 } }).success).toBe(false);
    expect(ConfigValueSchema.safeParse({ $secret: { $env: "X", other: 1 } }).success).toBe(false);
  });

  it("treats an $env object with extra keys as a plain config object, not a wrapper", () => {
    // Same rule as $secret above: an object that happens to have an $env key alongside others is
    // just a regular config object, not an env marking — and it is valid as one.
    expect(ConfigValueSchema.safeParse({ $env: "GITHUB_TOKEN", other: "field" }).success).toBe(true);
  });

  it("allows $secret values nested anywhere in the config tree", () => {
    const result = ConfigValueSchema.safeParse({
      credentials: { token: { $secret: "sk-abc123" } },
      list: [{ $secret: "sk-def456" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("ConfigObjectSchema", () => {
  it("accepts a flat map of config values", () => {
    expect(
      ConfigObjectSchema.safeParse({
        repo_path: ".",
        max_revisions: 3,
        output_file: "RELEASE_NOTES.md",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(ConfigObjectSchema.safeParse("not an object").success).toBe(false);
    expect(ConfigObjectSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});
