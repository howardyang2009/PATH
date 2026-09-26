import { describe, expect, it } from "vitest";
import { blockCancellation, rootCancellation, stopCause } from "../src/cancellation.js";
import type { Cancellation } from "../src/run-context.js";

/**
 * The cancellation authorities (`cancellation.ts`): the one place the cause taxonomy and the
 * signal-to-authority chaining live. The walks themselves are covered by `run-parallel.test.ts` and
 * `run-workflow.test.ts`; these prove the authority's own contract — first trigger wins, the cause
 * reads through the chain, and an outside abort still reaches the block's signal.
 */

describe("rootCancellation", () => {
  it("carries the operator cause, and aborts when the operator's signal does", () => {
    const operator = new AbortController();
    const root = rootCancellation(operator.signal);

    expect(root.signal.aborted).toBe(false);
    expect(stopCause(root)).toEqual({ cause: "operator", causeRunId: null });

    operator.abort();
    expect(root.signal.aborted).toBe(true);
  });

  it("starts aborted when the operator's signal already is — an abort before the first step", () => {
    const operator = new AbortController();
    operator.abort();
    expect(rootCancellation(operator.signal).signal.aborted).toBe(true);
  });

  it("has its own signal even with no operator signal, so a tree always has one authority", () => {
    const root = rootCancellation();
    expect(root.signal.aborted).toBe(false);
    expect(root.cause).toBe("operator");
  });
});

describe("blockCancellation", () => {
  const tree = rootCancellation();

  it("aborts its own signal when a sibling fails, naming the failing run", () => {
    const block = blockCancellation(tree, tree.signal);

    block.cancellation.trigger("villain-run");

    expect(block.cancellation.signal.aborted).toBe(true);
    expect(stopCause(block.cancellation)).toEqual({
      cause: "sibling-failed",
      causeRunId: "villain-run",
    });
  });

  it("keeps the first cause when a race win and a failure land together", () => {
    const block = blockCancellation(tree, tree.signal);

    block.cancellation.triggerWin();
    block.cancellation.trigger("late-run");

    expect(stopCause(block.cancellation)).toEqual({ cause: "sibling-succeeded", causeRunId: null });
  });

  it("reads through to its parent until it has a cause of its own — an outer failure is still ours", () => {
    const outer = blockCancellation(tree, tree.signal);
    const inner = blockCancellation(outer.cancellation, outer.cancellation.signal);

    // The inner block never failed; the outer sibling's failure is what stopped it.
    outer.cancellation.trigger("outer-villain");
    expect(stopCause(inner.cancellation)).toEqual({
      cause: "sibling-failed",
      causeRunId: "outer-villain",
    });

    // Once it has its own cause, that one wins — an outer failure does not overwrite a local verdict.
    inner.cancellation.triggerWin();
    expect(stopCause(inner.cancellation)).toEqual({ cause: "sibling-succeeded", causeRunId: null });
  });

  it("aborts with the outside signal, and stops listening once disposed", () => {
    const outside = new AbortController();
    const block = blockCancellation(tree, outside.signal);
    outside.abort();
    expect(block.cancellation.signal.aborted).toBe(true);

    const other = new AbortController();
    const disposed = blockCancellation(tree, other.signal);
    disposed.dispose();
    other.abort();
    expect(disposed.cancellation.signal.aborted).toBe(false);
  });

  it("starts aborted when the outside signal already is", () => {
    const outside = new AbortController();
    outside.abort();
    const block = blockCancellation(tree, outside.signal);
    expect(block.cancellation.signal.aborted).toBe(true);
  });
});

describe("stopCause", () => {
  it("falls back to the operator cause for a caller with no authority (a hand-built run)", () => {
    expect(stopCause(undefined)).toEqual({ cause: "operator", causeRunId: null });
  });

  it("reports an authority with no cause yet as operator, matching the pre-authority reading", () => {
    const silent: Cancellation = {
      signal: new AbortController().signal,
      cause: null,
      causeRunId: null,
      trigger: () => {},
      triggerWin: () => {},
    };
    expect(stopCause(silent)).toEqual({ cause: "operator", causeRunId: null });
  });
});
