import { describe, expect, it } from "vitest";
import { effectiveRootInput } from "../src/effective-root-input.js";

// The root-input fallback (format @4 §1a): a non-empty operator override wins, else the file's own
// top-level `input`, else `{}`. Every launch door resolves it through this one function, so `path run`
// and `POST /v0/runs` cannot disagree about which seed a run records.
describe("effectiveRootInput", () => {
  const fileInput = { ticket: 7 };

  it("uses a non-empty operator override verbatim", () => {
    expect(effectiveRootInput({ ticket: 9 }, fileInput)).toEqual({ ticket: 9 });
  });

  it("falls back to the file's own input seed for an absent or empty override", () => {
    expect(effectiveRootInput(undefined, fileInput)).toEqual({ ticket: 7 });
    expect(effectiveRootInput({}, fileInput)).toEqual({ ticket: 7 });
  });

  it("falls back to {} when neither an override nor a file seed is present", () => {
    expect(effectiveRootInput(undefined, undefined)).toEqual({});
    expect(effectiveRootInput({}, undefined)).toEqual({});
  });

  it("keeps an empty file seed empty rather than inventing keys", () => {
    expect(effectiveRootInput(undefined, {})).toEqual({});
  });
});
