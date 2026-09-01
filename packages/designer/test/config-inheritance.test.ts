import type { ConfigObject } from "@path/schema";
import { describe, expect, it } from "vitest";
import { configRows, dropConfigKey, setConfigKey } from "../src/config-inheritance.js";

describe("#370 config inheritance rows", () => {
  const fileConfig: ConfigObject = { model: "gpt", region: "eu", timeout: 30 };

  it("marks a file-only key inherited, a shared key overridden, a node-only key local", () => {
    const nodeConfig: ConfigObject = { region: "us", retries: 3 };
    const rows = configRows(fileConfig, nodeConfig);
    expect(rows).toEqual([
      { key: "model", value: "gpt", origin: "inherited" },
      { key: "region", value: "us", origin: "overridden" },
      { key: "retries", value: 3, origin: "local" },
      { key: "timeout", value: 30, origin: "inherited" },
    ]);
  });

  it("hides a first-class-owned key (a prompt's model edits elsewhere)", () => {
    const rows = configRows(fileConfig, undefined, new Set(["model"]));
    expect(rows.map((r) => r.key)).toEqual(["region", "timeout"]);
  });

  it("shows an empty list when neither the file nor the node declares config", () => {
    expect(configRows(undefined, undefined)).toEqual([]);
  });
});

describe("#370 config key writes", () => {
  it("adds and overwrites a local key", () => {
    expect(setConfigKey({ a: 1 }, "b", "x")).toEqual({ a: 1, b: "x" });
    expect(setConfigKey({ a: 1 }, "a", 2)).toEqual({ a: 2 });
  });

  it("drops a key, returning undefined when that empties the config", () => {
    expect(dropConfigKey({ a: 1, b: 2 }, "a")).toEqual({ b: 2 });
    expect(dropConfigKey({ a: 1 }, "a")).toBeUndefined();
  });
});
