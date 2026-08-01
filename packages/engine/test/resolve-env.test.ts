import type { ConfigObject } from "@path/schema";
import { describe, expect, it } from "vitest";
import { describeUnsetEnv, resolveConfigEnv, resolveRunEnv } from "../src/resolve-env.js";

describe("resolveConfigEnv", () => {
  it("replaces a wrapper with the variable's value", () => {
    const { config, unset } = resolveConfigEnv({ token: { $env: "TOKEN" } }, { TOKEN: "real-value" });
    expect(config).toEqual({ token: "real-value" });
    expect(unset).toEqual([]);
  });

  it("resolves a wrapper nested inside arrays and objects", () => {
    const config: ConfigObject = { creds: { headers: [{ auth: { $env: "TOKEN" } }] } };
    expect(resolveConfigEnv(config, { TOKEN: "real-value" }).config).toEqual({
      creds: { headers: [{ auth: "real-value" }] },
    });
  });

  it("resolves inside a $secret wrapper, leaving the marking standing over the value", () => {
    const { config } = resolveConfigEnv({ token: { $secret: { $env: "TOKEN" } } }, { TOKEN: "real-value" });
    expect(config).toEqual({ token: { $secret: "real-value" } });
  });

  it("leaves a config object's own $env-named field alone", () => {
    // A config object's *own* keys are field names, not wrapper positions (format §8.3): `"config":
    // {"$env": "TOKEN"}` declares a field awkwardly named `$env`. Walking the object itself rather
    // than each of its values would silently turn that one-field config into a wrapper.
    const config: ConfigObject = { $env: "TOKEN" };
    expect(resolveConfigEnv(config, { TOKEN: "real-value" }).config).toEqual({ $env: "TOKEN" });
  });

  it("records an unset variable with the config key it was named under, wrapper left standing", () => {
    const { config, unset } = resolveConfigEnv({ creds: { auth: { $env: "TOKEN" } } }, {});
    expect(unset).toEqual([{ name: "TOKEN", key: "creds.auth" }]);
    expect(config).toEqual({ creds: { auth: { $env: "TOKEN" } } });
  });

  it("counts an empty variable as set", () => {
    // `FOO=` exports an empty value; only an *absent* name is unset. The engine cannot know whether
    // an empty value is meaningful, and conflating the two would make `FOO=` unexpressible.
    const { config, unset } = resolveConfigEnv({ token: { $env: "TOKEN" } }, { TOKEN: "" });
    expect(config).toEqual({ token: "" });
    expect(unset).toEqual([]);
  });

  it("leaves values carrying no wrapper untouched", () => {
    const config: ConfigObject = { model: "claude", retries: 3, flags: [true, null] };
    expect(resolveConfigEnv(config, {}).config).toEqual(config);
  });
});

describe("resolveRunEnv", () => {
  it("answers both halves of the run-start reading from one walk", () => {
    const { configs, unset } = resolveRunEnv([{ a: { $env: "SET" } }, { b: { $env: "MISSING" } }], { SET: "v" });
    expect(configs).toEqual([{ a: "v" }, { b: { $env: "MISSING" } }]);
    expect(unset).toEqual([{ name: "MISSING", key: "b" }]);
  });

  it("reports every unset variable across every config object, in first-seen order", () => {
    const { unset } = resolveRunEnv([{ a: { $env: "FIRST" } }, { b: { $env: "SECOND" } }], {});
    expect(unset).toEqual([
      { name: "FIRST", key: "a" },
      { name: "SECOND", key: "b" },
    ]);
  });

  it("reports one variable once, under the first config key naming it", () => {
    const { unset } = resolveRunEnv([{ a: { $env: "TOKEN" } }, { b: { $env: "TOKEN" } }], {});
    expect(unset).toEqual([{ name: "TOKEN", key: "a" }]);
  });
});

describe("describeUnsetEnv", () => {
  it("names the one unset variable and where it was found", () => {
    // Worded for what happened: the run started, is on the record, and ended before its first step.
    expect(describeUnsetEnv([{ name: "TOKEN", key: "creds.auth" }])).toBe(
      'run failed before its first step: environment variable "TOKEN" (config key "creds.auth") is not set',
    );
  });

  it("names every unset variable in one message, not just the first", () => {
    const message = describeUnsetEnv([
      { name: "FIRST", key: "a" },
      { name: "SECOND", key: "b" },
    ]);
    expect(message).toContain("FIRST");
    expect(message).toContain("SECOND");
    expect(message).toMatch(/2 environment variables are not set/);
  });
});
