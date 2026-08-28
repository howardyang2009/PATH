import { describe, expect, it, vi } from "vitest";
import { composeObservers, type Observation, ObserverError, type RunObserver } from "../src/run-observer.js";

const started: Observation = {
  type: "run-started",
  runId: "r",
  rootRunId: "r",
  parentRunId: null,
  nodeId: null, nodeName: null,
  input: {},
};
const finished: Observation = { type: "step-finished", runId: "r", rootRunId: "r", status: "succeeded", output: {} };

describe("composeObservers", () => {
  it("fans every observation out to every observer, in argument order", async () => {
    const calls: string[] = [];
    const a: RunObserver = { observe: () => void calls.push("a") };
    const b: RunObserver = { observe: () => void calls.push("b") };

    await composeObservers(a, b).observe(started);
    await composeObservers(a, b).observe(finished);
    expect(calls).toEqual(["a", "b", "a", "b"]);
  });

  it("delivers the observation unchanged to each member", async () => {
    const seen = vi.fn();
    await composeObservers({ observe: seen }, { observe: seen }).observe(started);
    expect(seen).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenNthCalledWith(1, started);
    expect(seen).toHaveBeenNthCalledWith(2, started);
  });

  it("propagates an ObserverError thrown by any member so the engine can fail the run", async () => {
    const boom: RunObserver = {
      observe: () => {
        throw new ObserverError("backend down");
      },
    };
    await expect(composeObservers({ observe: () => {} }, boom).observe(finished)).rejects.toBeInstanceOf(ObserverError);
  });

  // The ordering contract composeObservers documents: persistence must have run before a logging
  // failure aborts the fan-out, or a run whose audit failed would also have no row.
  it("does not run observers after one that threw", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const boom: RunObserver = {
      observe: () => {
        throw new ObserverError("backend down");
      },
    };
    await expect(composeObservers({ observe: before }, boom, { observe: after }).observe(finished)).rejects.toThrow();
    expect(before).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
  });

  it("awaits an async member before starting the next", async () => {
    const calls: string[] = [];
    const slow: RunObserver = {
      observe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push("slow");
      },
    };
    const fast: RunObserver = { observe: () => void calls.push("fast") };
    await composeObservers(slow, fast).observe(started);
    expect(calls).toEqual(["slow", "fast"]);
  });
});
