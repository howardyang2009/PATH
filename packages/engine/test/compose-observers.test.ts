import { describe, expect, it, vi } from "vitest";
import {
  composeObservers,
  ObserverError,
  type RunEvent,
  type RunObserver,
} from "../src/run-observer.js";

const env = { ts: "2026-01-01T00:00:00.000Z", run_id: "r" };
const started: RunEvent = {
  runId: "r",
  rootRunId: "r",
  event: {
    type: "step-started",
    ...env,
    node_id: null,
    node_name: null,
    step_type: "workflow",
    worker_name: "workflow",
  },
  payload: { kind: "started", parentRunId: null, input: {} },
};
const finished: RunEvent = {
  runId: "r",
  rootRunId: "r",
  event: { type: "step-finished", ...env, node_id: "n", node_name: "n", status: "succeeded" },
  payload: { kind: "output", output: {} },
};

describe("composeObservers", () => {
  it("fans every event out to every observer, in argument order", async () => {
    const calls: string[] = [];
    const a: RunObserver = { observe: () => void calls.push("a") };
    const b: RunObserver = { observe: () => void calls.push("b") };

    await composeObservers(a, b).observe(started);
    await composeObservers(a, b).observe(finished);
    expect(calls).toEqual(["a", "b", "a", "b"]);
  });

  it("delivers the event unchanged to each member", async () => {
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
    await expect(
      composeObservers({ observe: () => {} }, boom).observe(finished),
    ).rejects.toBeInstanceOf(ObserverError);
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
    await expect(
      composeObservers({ observe: before }, boom, { observe: after }).observe(finished),
    ).rejects.toThrow();
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
