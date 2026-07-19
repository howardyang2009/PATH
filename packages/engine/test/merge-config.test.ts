import { describe, expect, it } from "vitest";
import { mergeConfig } from "../src/merge-config.js";

describe("mergeConfig", () => {
  it("shallow-merges per top-level key, override wins", () => {
    expect(mergeConfig({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("returns the base unchanged when override is undefined", () => {
    expect(mergeConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("does not deep-merge nested objects — override replaces the whole key", () => {
    expect(mergeConfig({ a: { x: 1, y: 2 } }, { a: { x: 9 } })).toEqual({ a: { x: 9 } });
  });

  it("does not mutate either input", () => {
    const base = { a: 1 };
    const override = { b: 2 };
    mergeConfig(base, override);
    expect(base).toEqual({ a: 1 });
    expect(override).toEqual({ b: 2 });
  });
});
