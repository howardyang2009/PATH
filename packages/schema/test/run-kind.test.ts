import { describe, expect, it } from "vitest";
import { isIterationRun, isReuseRow, isRootRun, runKind, type RunKindFields } from "../src/run-kind.js";

/** The five row shapes the `runs` table holds, minimal to the fields the kind is read from. */
const root: RunKindFields = { parentRunId: null, reusedFromRunId: null, workerName: null, iteration: null };
const nested: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: null };
const leaf: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: "spawn", iteration: null };
const reuse: RunKindFields = { parentRunId: "root-1", reusedFromRunId: "src-leaf", workerName: null, iteration: null };
const iteration: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: 2 };

describe("runKind", () => {
  it("classifies each of the five row kinds", () => {
    expect(runKind(root)).toBe("root");
    expect(runKind(nested)).toBe("nested-workflow");
    expect(runKind(leaf)).toBe("leaf");
    expect(runKind(reuse)).toBe("reuse");
    expect(runKind(iteration)).toBe("iteration");
  });

  it("reads a reuse row as reuse even though it has a parent (reuse is tested first)", () => {
    // A reuse row carries a parent and no worker, the same as a nested workflow-run — the reuse
    // pointer is what tells them apart, so it must win over the root and worker checks.
    expect(runKind({ parentRunId: "root-1", reusedFromRunId: "src", workerName: null, iteration: null })).toBe("reuse");
  });

  it("reads an iteration container before the worker-name test (worker-less, but its own kind)", () => {
    // An iteration container is worker-less like a nested workflow-run; its `iteration` ordinal is
    // what tells them apart, so it must win over the nested-workflow fall-through.
    expect(runKind({ parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: 1 })).toBe("iteration");
  });

  it("never returns a sixth kind (exhaustive over the union)", () => {
    // The return type is the RunKind union; this pins the value set the classifier can produce.
    const kinds: ReadonlyArray<ReturnType<typeof runKind>> = [root, nested, leaf, reuse, iteration].map(runKind);
    expect(new Set(kinds)).toEqual(new Set(["root", "nested-workflow", "leaf", "reuse", "iteration"]));
  });
});

describe("isReuseRow / isRootRun / isIterationRun", () => {
  it("isReuseRow is true only for a row carrying a reuse pointer", () => {
    expect(isReuseRow(reuse)).toBe(true);
    expect(isReuseRow(root)).toBe(false);
    expect(isReuseRow(leaf)).toBe(false);
  });

  it("isRootRun is true only for a parentless row", () => {
    expect(isRootRun(root)).toBe(true);
    expect(isRootRun(nested)).toBe(false);
    expect(isRootRun(reuse)).toBe(false);
  });

  it("isIterationRun is true only for a row carrying an iteration ordinal", () => {
    expect(isIterationRun(iteration)).toBe(true);
    expect(isIterationRun(root)).toBe(false);
    expect(isIterationRun(nested)).toBe(false);
  });
});
