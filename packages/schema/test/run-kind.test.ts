import { describe, expect, it } from "vitest";
import { isIterationRun, isReuseRow, isRootRun, type RunKindFields } from "../src/run-kind.js";

/** The five row shapes the `runs` table holds, minimal to the fields the kind is read from. */
const root: RunKindFields = { parentRunId: null, reusedFromRunId: null, workerName: null, iteration: null };
const nested: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: null };
const leaf: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: "spawn", iteration: null };
const reuse: RunKindFields = { parentRunId: "root-1", reusedFromRunId: "src-leaf", workerName: null, iteration: null };
const iteration: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: 2 };

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
