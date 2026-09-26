import { describe, expect, it } from "vitest";
import { updateAtConfigPath, valueAtConfigPath } from "../src/config-path.js";

describe("valueAtConfigPath", () => {
  it("reads nested object keys and array indices", () => {
    expect(valueAtConfigPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c")).toBe(7);
  });

  it("is undefined for a missing path, a non-index segment on an array, or no value at all", () => {
    expect(valueAtConfigPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(valueAtConfigPath({ a: [1] }, "a.x")).toBeUndefined();
    expect(valueAtConfigPath(undefined, "a")).toBeUndefined();
  });

  it("does not read inherited object properties", () => {
    expect(valueAtConfigPath({}, "constructor")).toBeUndefined();
  });
});

describe("updateAtConfigPath", () => {
  it("replaces the leaf through objects and arrays, copying only the path", () => {
    const shared = { untouched: true };
    const value = { a: [{ b: "x" }, shared], other: shared };
    const updated = updateAtConfigPath(value, "a.0.b", (leaf) => `${leaf as string}!`);
    expect(updated).toEqual({ a: [{ b: "x!" }, shared], other: shared });
    expect((updated as typeof value).other).toBe(shared);
    expect(value.a[0]).toEqual({ b: "x" });
  });

  it("returns the value unchanged when the path does not exist", () => {
    const value = { a: 1 };
    expect(updateAtConfigPath(value, "b.c", () => "nope")).toBe(value);
  });
});
