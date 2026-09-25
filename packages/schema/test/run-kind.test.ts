import { describe, expect, it } from "vitest";
import { isIterationRun, isPassRun, isReuseRow, isRootRun, type RunKindFields } from "../src/run-kind.js";

/** The six row shapes the `runs` table holds, minimal to the fields the kind is read from. */
const root: RunKindFields = { parentRunId: null, reusedFromRunId: null, workerName: null, iteration: null, pass: null };
const nested: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: null, pass: null };
const leaf: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: "spawn", iteration: null, pass: null };
const reuse: RunKindFields = { parentRunId: "root-1", reusedFromRunId: "src-leaf", workerName: null, iteration: null, pass: null };
const iteration: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: 2, pass: null };
const pass: RunKindFields = { parentRunId: "root-1", reusedFromRunId: null, workerName: null, iteration: null, pass: 3 };

describe("isReuseRow / isRootRun / isIterationRun / isPassRun", () => {
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
    expect(isIterationRun(pass)).toBe(false);
  });

  it("isPassRun is true only for a row carrying a pass ordinal", () => {
    expect(isPassRun(pass)).toBe(true);
    expect(isPassRun(iteration)).toBe(false);
    expect(isPassRun(root)).toBe(false);
  });
});
