import { describe, expect, it } from "vitest";
import {
  buildLaunchFacts,
  describeMissingLaunchSecrets,
  recoverLaunchConfig,
  secretPathsOf,
  valueAtPath,
  wrapSecretsAtPaths,
} from "../src/launch-facts.js";

// The launch-facts helpers, at their own boundary (ADR 0046): which config paths are secrets, what a
// launch freezes, what a continuation recovers, and how a missing secret is worded. The end-to-end
// behaviour they serve is pinned in `project.test.ts` and `complete.test.ts`.

describe("secretPathsOf", () => {
  it("names every dot-path holding a $secret, including nested and array positions", () => {
    expect(
      secretPathsOf({
        apiKey: { $secret: "sk-1" },
        options: { nested: { $secret: "sk-2" } },
        list: [{ $secret: "sk-3" }],
        plain: "not-a-secret",
      }),
    ).toEqual(["apiKey", "options.nested", "list.0"]);
  });

  it("treats a config field named $secret as a field, not a wrapper", () => {
    expect(secretPathsOf({ $secret: "literal" })).toEqual([]);
  });
});

describe("valueAtPath", () => {
  it("reads nested object and array positions, and answers undefined for a missing path", () => {
    expect(valueAtPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c")).toBe(7);
    expect(valueAtPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(valueAtPath(undefined, "a")).toBeUndefined();
  });
});

describe("buildLaunchFacts", () => {
  it("freezes the input and worker table verbatim and the config resolved, with its secret paths", () => {
    expect(
      buildLaunchFacts(
        {
          input: { topic: "release" },
          config: { model: "m", apiKey: { $secret: "sk-1" } },
          workerDefaults: { prompt: "deepseek" },
        },
        {},
      ),
    ).toEqual({
      input: { topic: "release" },
      config: { model: "m", apiKey: "sk-1" },
      workerDefaults: { prompt: "deepseek" },
      secretKeys: ["apiKey"],
    });
  });

  it("answers undefined for a launch that supplied nothing beyond the file", () => {
    expect(buildLaunchFacts({}, {})).toBeUndefined();
  });

  it("keeps secret paths a continuation inherited, whose wrappers are already gone", () => {
    expect(buildLaunchFacts({ config: { apiKey: "sk-2" } }, {}, ["apiKey"])).toEqual({
      config: { apiKey: "sk-2" },
      secretKeys: ["apiKey"],
    });
  });
});

describe("recoverLaunchConfig", () => {
  const frozen = { config: { model: "m", apiKey: "[secret:apiKey]" }, secretKeys: ["apiKey"] };

  it("uses the frozen config when the caller supplies none, and names the missing secrets", () => {
    expect(recoverLaunchConfig(frozen, undefined)).toEqual({
      config: frozen.config,
      missingSecretKeys: ["apiKey"],
    });
  });

  it("merges a supplied config over the frozen one, shallow and supplied-wins", () => {
    expect(recoverLaunchConfig(frozen, { apiKey: "sk-2", extra: 1 }).config).toEqual({
      model: "m",
      apiKey: "sk-2",
      extra: 1,
    });
    expect(recoverLaunchConfig(frozen, { apiKey: "sk-2" }).missingSecretKeys).toEqual([]);
  });

  it("has nothing to recover from a launch that recorded no facts", () => {
    expect(recoverLaunchConfig(undefined, { a: 1 })).toEqual({ config: { a: 1 }, missingSecretKeys: [] });
  });
});

describe("wrapSecretsAtPaths", () => {
  it("re-marks a supplied value at each recorded path, nested or flat", () => {
    expect(wrapSecretsAtPaths({ apiKey: "sk-2", options: { token: "t" }, other: "x" }, ["apiKey", "options.token"])).toEqual({
      apiKey: { $secret: "sk-2" },
      options: { token: { $secret: "t" } },
      other: "x",
    });
  });

  it("leaves an already-wrapped value and an absent path alone", () => {
    const already = { apiKey: { $secret: "sk-2" } };
    expect(wrapSecretsAtPaths(already, ["apiKey"])).toEqual(already);
    expect(wrapSecretsAtPaths({ a: 1 }, ["missing.key"])).toEqual({ a: 1 });
  });
});

describe("describeMissingLaunchSecrets", () => {
  it("names one key or several, wording each as a run that ended before its first step", () => {
    expect(describeMissingLaunchSecrets(["apiKey"])).toBe(
      'run failed before its first step: launch config secret "apiKey" was not supplied again',
    );
    expect(describeMissingLaunchSecrets(["a", "b"])).toBe(
      'run failed before its first step: 2 launch config secrets were not supplied again: "a", "b"',
    );
  });
});
