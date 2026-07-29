import { describe, expect, it } from "vitest";
import type { JsonValue } from "../src/json-value.js";
import { isSecretWrapper, mapSecrets } from "../src/secret.js";

/** Collects what a walk reached, so a test can assert the paths without a second walk. */
function pathsOf(value: JsonValue, basePath = ""): { secret: string; path: string }[] {
  const seen: { secret: string; path: string }[] = [];
  mapSecrets(
    value,
    (secret, path) => {
      seen.push({ secret, path });
      return secret;
    },
    basePath,
  );
  return seen;
}

describe("isSecretWrapper", () => {
  it("accepts a sole-key wrapper holding a string", () => {
    expect(isSecretWrapper({ $secret: "sk-live-1" })).toBe(true);
  });

  it("rejects a multi-key object that merely carries a $secret key", () => {
    // Otherwise an author's ordinary object would silently become a secret the moment it grew a
    // field called `$secret`.
    expect(isSecretWrapper({ $secret: "sk-live-1", note: "not a wrapper" })).toBe(false);
  });

  it("rejects a $secret whose value is not a string", () => {
    expect(isSecretWrapper({ $secret: 42 })).toBe(false);
    expect(isSecretWrapper({ $secret: null })).toBe(false);
    expect(isSecretWrapper({ $secret: { $secret: "nested" } })).toBe(false);
  });

  it("rejects arrays, null and scalars", () => {
    expect(isSecretWrapper(["$secret"])).toBe(false);
    expect(isSecretWrapper(null)).toBe(false);
    expect(isSecretWrapper("$secret")).toBe(false);
    expect(isSecretWrapper(7)).toBe(false);
  });
});

describe("mapSecrets", () => {
  it("replaces a wrapper with what visit returns", () => {
    expect(mapSecrets({ $secret: "sk-live-1" }, (secret) => secret)).toBe("sk-live-1");
  });

  it("reaches a wrapper at any depth, through objects and arrays alike", () => {
    const value = {
      shallow: { $secret: "one" },
      nested: { deeper: { $secret: "two" } },
      list: [{ $secret: "three" }, "plain"],
    };

    expect(pathsOf(value).map((s) => s.secret)).toEqual(["one", "two", "three"]);
  });

  it("dot-joins the path from the base path, with array indices as segments", () => {
    const value = { creds: { tokens: [{ $secret: "one" }] } };

    expect(pathsOf(value, "config")).toEqual([{ secret: "one", path: "config.creds.tokens.0" }]);
  });

  it("starts the path at the first segment when no base path is given", () => {
    expect(pathsOf({ api: { $secret: "one" } })).toEqual([{ secret: "one", path: "api" }]);
  });

  it("leaves every non-wrapper leaf untouched, including one that looks like a wrapper", () => {
    const value = {
      keep: "plain",
      n: 1,
      flag: false,
      nothing: null,
      "not-a-wrapper": { $secret: "s", note: "two keys" },
      list: [1, "two"],
    };

    expect(mapSecrets(value, () => "REPLACED")).toEqual(value);
  });

  it("does not walk into the wrapper's own string", () => {
    // The secret is the value, not more structure: a visit that returns another wrapper is handed
    // back as-is rather than being re-visited, which would not terminate.
    expect(mapSecrets({ $secret: "one" }, () => ({ $secret: "two" }))).toEqual({ $secret: "two" });
  });

  it("visits every occurrence, so a value repeated under two keys is reported twice", () => {
    // Which occurrence wins a token is the caller's policy (secret-mask keeps the first); the walk
    // itself hides none of them.
    const value = { a: { $secret: "same" }, b: { $secret: "same" } };

    expect(pathsOf(value)).toEqual([
      { secret: "same", path: "a" },
      { secret: "same", path: "b" },
    ]);
  });
});
