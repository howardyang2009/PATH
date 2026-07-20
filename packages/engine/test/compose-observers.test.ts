import { describe, expect, it, vi } from "vitest";
import { composeObservers, ObserverError, type RunObserver } from "../src/run-observer.js";

describe("composeObservers", () => {
  it("fans each lifecycle hook out to every observer, in order", async () => {
    const calls: string[] = [];
    const a: RunObserver = { runStarted: () => void calls.push("a") };
    const b: RunObserver = { runStarted: () => void calls.push("b") };

    await composeObservers(a, b).runStarted?.({ runId: "r", rootRunId: "r", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    expect(calls).toEqual(["a", "b"]);
  });

  it("tolerates observers that only implement some hooks", async () => {
    const only = { stepStarted: vi.fn() } satisfies RunObserver;
    const composed = composeObservers(only);
    await composed.runFinished?.({ runId: "r", rootRunId: "r", status: "succeeded", output: {} });
    expect(only.stepStarted).not.toHaveBeenCalled();
  });

  it("propagates an ObserverError thrown by any member so the engine can fail the run", async () => {
    const boom: RunObserver = {
      stepFinished: () => {
        throw new ObserverError("backend down");
      },
    };
    await expect(
      composeObservers({}, boom).stepFinished?.({ runId: "r", rootRunId: "r", status: "succeeded", output: {} }),
    ).rejects.toBeInstanceOf(ObserverError);
  });
});
