import { describe, expect, it } from "vitest";
import { isEnvWrapper, mapEnv } from "../src/env.js";
import type { JsonValue } from "../src/json-value.js";

/** Collects what a walk reached, so a test can assert the paths without a second walk. */
function pathsOf(value: JsonValue, basePath = ""): { name: string; path: string }[] {
  const seen: { name: string; path: string }[] = [];
  mapEnv(
    value,
    (name, path) => {
      seen.push({ name, path });
      return name;
    },
    basePath,
  );
  return seen;
}

describe("isEnvWrapper", () => {
  it("accepts a sole-key wrapper holding a string", () => {
    expect(isEnvWrapper({ $env: "GITHUB_TOKEN" })).toBe(true);
  });

  it("rejects a multi-key object that merely carries an $env key", () => {
    // Same rule `isSecretWrapper` states: an author's ordinary object does not become a wrapper the
    // moment it grows a field called `$env`.
    expect(isEnvWrapper({ $env: "GITHUB_TOKEN", note: "not a wrapper" })).toBe(false);
  });

  it("rejects an $env whose value is not a string", () => {
    expect(isEnvWrapper({ $env: 3 })).toBe(false);
    expect(isEnvWrapper({ $env: null })).toBe(false);
    expect(isEnvWrapper({ $env: { $env: "nested" } })).toBe(false);
  });

  it("rejects arrays, null and scalars", () => {
    expect(isEnvWrapper(["$env"])).toBe(false);
    expect(isEnvWrapper(null)).toBe(false);
    expect(isEnvWrapper("$env")).toBe(false);
    expect(isEnvWrapper(7)).toBe(false);
  });
});

describe("mapEnv", () => {
  it("replaces a wrapper with what visit returns", () => {
    expect(mapEnv({ $env: "GITHUB_TOKEN" }, () => "ghp-real")).toBe("ghp-real");
  });

  it("reaches a wrapper at any depth, through objects and arrays alike", () => {
    const value = {
      shallow: { $env: "ONE" },
      nested: { deeper: { $env: "TWO" } },
      list: [{ $env: "THREE" }, "plain"],
    };

    expect(pathsOf(value).map((e) => e.name)).toEqual(["ONE", "TWO", "THREE"]);
  });

  it("dot-joins the path from the base path, with array indices as segments", () => {
    const value = { creds: { tokens: [{ $env: "ONE" }] } };

    expect(pathsOf(value, "config")).toEqual([{ name: "ONE", path: "config.creds.tokens.0" }]);
  });

  it("starts the path at the first segment when no base path is given", () => {
    expect(pathsOf({ api: { $env: "ONE" } })).toEqual([{ name: "ONE", path: "api" }]);
  });

  it("leaves every non-wrapper leaf untouched, including one that looks like a wrapper", () => {
    const value = {
      keep: "plain",
      n: 1,
      flag: false,
      nothing: null,
      "not-a-wrapper": { $env: "ONE", note: "two keys" },
      list: [1, "two"],
    };

    expect(mapEnv(value, () => "REPLACED")).toEqual(value);
  });

  it("does not walk into the wrapper's own string", () => {
    // The variable name is the value, not more structure: a visit that returns another wrapper is
    // handed back as-is rather than being re-visited, which would not terminate.
    expect(mapEnv({ $env: "ONE" }, () => ({ $env: "TWO" }))).toEqual({ $env: "TWO" });
  });

  it("reaches an $env sitting inside a $secret wrapper, resolving it in place", () => {
    // The composed case the engine depends on: `{"$secret": {"$env": "NAME"}}` sources *and* marks
    // secret, so resolution must reach through the marking and leave the marking standing.
    expect(mapEnv({ token: { $secret: { $env: "GITHUB_TOKEN" } } }, () => "ghp-real")).toEqual({
      token: { $secret: "ghp-real" },
    });
  });

  it("reports the composed case under the path of the marked value, not a $secret segment", () => {
    // `mapSecrets` reports `{a: {$secret: "s"}}` under `a`; the marking is not a level of structure,
    // so the two walks must agree that the wrapper sits *at* `a`.
    expect(pathsOf({ a: { $secret: { $env: "ONE" } } })).toEqual([{ name: "ONE", path: "a" }]);
  });

  it("leaves a $secret holding a literal string untouched", () => {
    const value = { token: { $secret: "sk-live-1" } };

    expect(mapEnv(value, () => "REPLACED")).toEqual(value);
  });

  it("visits every occurrence, so a variable named under two keys is reported twice", () => {
    const value = { a: { $env: "SAME" }, b: { $env: "SAME" } };

    expect(pathsOf(value)).toEqual([
      { name: "SAME", path: "a" },
      { name: "SAME", path: "b" },
    ]);
  });
});
