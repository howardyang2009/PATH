import { describe, expect, it } from "vitest";
import { blankRunRecord, type RunRecord } from "@path/schema";
import { runBlobSource } from "../src/blob-source.js";

/**
 * The one owner of "which run holds this blob, and where does it live on disk" (#architecture-deepening):
 * the Viewer used to swap a filename on a sibling ref, hand-build `runs/<root>/<run>/context.json`, and
 * spell the predecessor's path for a successor root. These pin the three answers a surface needs — the
 * addressing, the gate, and the provenance line — over the layouts `@path/engine` writes.
 */

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { ...blankRunRecord({ runId: "run-1", rootRunId: "root-1" }), ...overrides };
}

describe("runBlobSource — input", () => {
  it("reads a plain run's own input, gated by its own ref", () => {
    expect(runBlobSource(run({ inputRef: "runs/root-1/run-1/input.json" }), "input")).toEqual({
      rootRunId: "root-1",
      runId: "run-1",
      gatedBy: "runs/root-1/run-1/input.json",
      ref: "runs/root-1/run-1/input.json",
      resumedFrom: null,
    });
  });

  it("reads a successor root's input from the predecessor tree, ungated", () => {
    const successor = run({ parentRunId: null, resumedFromRootRunId: "root-0" });

    expect(runBlobSource(successor, "input")).toEqual({
      rootRunId: "root-0",
      runId: "root-0",
      gatedBy: null,
      ref: "runs/root-0/root-0/input.json",
      resumedFrom: "root-0",
    });
  });

  it("keeps a nested run's own input even when the tree was resumed", () => {
    // Only the successor *root* reaches back; a nested row's predecessor is its tree's, not its own.
    const nested = run({ parentRunId: "root-1", resumedFromRootRunId: "root-0" });

    expect(runBlobSource(nested, "input")).toMatchObject({ rootRunId: "root-1", runId: "run-1", resumedFrom: null });
  });
});

describe("runBlobSource — output", () => {
  it("carries the record's own output ref as both the gate and the provenance line", () => {
    const source = runBlobSource(run({ outputRef: "runs/root-1/run-1/output.json" }), "output");

    expect(source).toEqual({
      rootRunId: "root-1",
      runId: "run-1",
      gatedBy: "runs/root-1/run-1/output.json",
      ref: "runs/root-1/run-1/output.json",
      resumedFrom: null,
    });
  });

  it("has no ref for an object the run never recorded", () => {
    expect(runBlobSource(run(), "output")).toMatchObject({ gatedBy: null, ref: null });
  });
});

describe("runBlobSource — context", () => {
  it("derives the path from the run's own blob directory, ungated", () => {
    expect(runBlobSource(run(), "context")).toEqual({
      rootRunId: "root-1",
      runId: "run-1",
      gatedBy: null,
      ref: "runs/root-1/run-1/context.json",
      resumedFrom: null,
    });
  });

  it("swaps the filename on a sibling ref when the record carries one", () => {
    const source = runBlobSource(run({ inputRef: "runs/root-1/run-1/input.json" }), "context");

    expect(source.ref).toBe("runs/root-1/run-1/context.json");
    expect(source.gatedBy).toBeNull();
  });

  it("prefers the input ref over the output ref when both are present", () => {
    const source = runBlobSource(
      run({ inputRef: "runs/root-1/run-1/input.json", outputRef: "runs/root-1/run-1/output.json" }),
      "context",
    );

    expect(source.ref).toBe("runs/root-1/run-1/context.json");
  });
});
