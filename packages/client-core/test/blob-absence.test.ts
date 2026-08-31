import { describe, expect, it } from "vitest";
import { PathApiError } from "../src/api-client.js";
import { planBlobRead, resolveBlobError } from "../src/blob-absence.js";

/**
 * The pure blob-absence rule the run-io surface wires a hook around (#359). The rule fails in
 * opposite directions on either side of a run's settle: a still-running ref-less read is skipped
 * (a 404 could be a stale selection, `get-run-blob.ts`), while a terminal run is read regardless of
 * its ref and its 404 is trusted (its ref may lag a snapshot no tree read has refreshed, #51).
 */
describe("planBlobRead", () => {
  it("skips the read for a still-running run with no ref, and reports the object absent", () => {
    expect(planBlobRead(null, false)).toEqual({ read: false, content: { present: false } });
  });

  it("reads a terminal run even when its ref is null", () => {
    expect(planBlobRead(null, true)).toEqual({ read: true });
  });

  it("reads whenever a ref is in hand, running or terminal", () => {
    expect(planBlobRead("runs/r1/input", false)).toEqual({ read: true });
    expect(planBlobRead("runs/r1/input", true)).toEqual({ read: true });
  });
});

describe("resolveBlobError", () => {
  it("reads a 404 as absence when the record names no ref", () => {
    const error = new PathApiError(404, "not found");
    expect(resolveBlobError(null, error)).toEqual({ present: false });
  });

  it("surfaces a 404 as an error when a ref was known — the record and the disk disagree", () => {
    const error = new PathApiError(404, "not found");
    expect(resolveBlobError("runs/r1/input", error)).toBeNull();
  });

  it("surfaces a non-404 API error even with no ref", () => {
    const error = new PathApiError(500, "boom");
    expect(resolveBlobError(null, error)).toBeNull();
  });

  it("surfaces a non-API error", () => {
    expect(resolveBlobError(null, new Error("network down"))).toBeNull();
  });
});
