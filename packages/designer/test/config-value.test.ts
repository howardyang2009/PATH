import { describe, expect, it } from "vitest";
import {
  configModeOf,
  envNameOf,
  isEditableScalar,
  referenceLabel,
  renderConfigValue,
  setConfigMode,
  setSecretSource,
} from "../src/config-value.js";

/**
 * The pure config-value shape algebra (#370). The mode transitions and the reference-only label are the
 * bug-prone part — a lost `$env` name across a mode switch, or a secret that resolves instead of masking.
 * These tests hit them directly, off the pane's render path.
 */

describe("configModeOf / isEditableScalar", () => {
  it("reads the mode off the value's shape", () => {
    expect(configModeOf("x")).toBe("literal");
    expect(configModeOf(7)).toBe("literal");
    expect(configModeOf({ $env: "TOKEN" })).toBe("env");
    expect(configModeOf({ $secret: "s" })).toBe("secret");
    expect(configModeOf({ $secret: { $env: "TOKEN" } })).toBe("secret");
  });

  it("isEditableScalar accepts scalars, rejects wrappers", () => {
    expect(isEditableScalar("x")).toBe(true);
    expect(isEditableScalar(0)).toBe(true);
    expect(isEditableScalar(false)).toBe(true);
    expect(isEditableScalar({ $env: "X" })).toBe(false);
  });
});

describe("referenceLabel (reference-only, never resolved)", () => {
  it("labels an $env by its variable name", () => {
    expect(referenceLabel({ $env: "TOKEN" })).toBe("$env · TOKEN");
  });

  it("masks a literal secret with bullets, never its value", () => {
    expect(referenceLabel({ $secret: "hunter2" })).toBe("$secret · ••••••");
  });

  it("labels an env-sourced secret by the env name", () => {
    expect(referenceLabel({ $secret: { $env: "TOKEN" } })).toBe("$secret · $env · TOKEN");
  });

  it("a plain scalar is not a reference", () => {
    expect(referenceLabel("x")).toBeNull();
  });
});

describe("renderConfigValue", () => {
  it("renders a wrapper as its label and a scalar as itself, never a secret's value", () => {
    expect(renderConfigValue("x")).toBe("x");
    expect(renderConfigValue(3)).toBe("3");
    expect(renderConfigValue({ $env: "T" })).toBe("$env · T");
    expect(renderConfigValue({ $secret: "hunter2" })).toBe("$secret · ••••••");
  });
});

describe("setConfigMode (preserves the $env name across the switch)", () => {
  it("literal clears to an empty string", () => {
    expect(setConfigMode({ $env: "TOKEN" }, "literal")).toBe("");
  });

  it("literal → env → secret carries the env name the whole walk", () => {
    const env = setConfigMode("", "env");
    expect(env).toEqual({ $env: "" });
    const named = { $env: "TOKEN" };
    expect(setConfigMode(named, "secret")).toEqual({ $secret: { $env: "TOKEN" } });
  });

  it("secret with no known env name is a bare literal secret", () => {
    expect(setConfigMode("plain", "secret")).toEqual({ $secret: "" });
  });

  it("envNameOf reaches the name inside an env-sourced secret", () => {
    expect(envNameOf({ $secret: { $env: "TOKEN" } })).toBe("TOKEN");
    expect(envNameOf("plain")).toBe("");
  });
});

describe("setSecretSource", () => {
  it("env composes {$secret:{$env}}, preserving the name; literal collapses to {$secret:''}", () => {
    expect(setSecretSource({ $secret: { $env: "TOKEN" } }, "literal")).toEqual({ $secret: "" });
    expect(setSecretSource({ $secret: "x" }, "env")).toEqual({ $secret: { $env: "" } });
    expect(setSecretSource({ $secret: { $env: "TOKEN" } }, "env")).toEqual({ $secret: { $env: "TOKEN" } });
  });
});
