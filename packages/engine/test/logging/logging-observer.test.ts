import { describe, expect, it, vi } from "vitest";
import type { LogBackend } from "../../src/logging/log-backend.js";
import { LogEventSchema, type LogEvent } from "../../src/logging/log-event.js";
import { createLoggingObserver } from "../../src/logging/logging-observer.js";

function recordingBackend(): { backend: LogBackend; events: LogEvent[]; opened: string[]; closed: number } {
  const events: LogEvent[] = [];
  const opened: string[] = [];
  const state = { closed: 0 };
  const backend: LogBackend = {
    async open({ runId }) {
      opened.push(runId);
    },
    async write(event) {
      events.push(LogEventSchema.parse(event)); // every event must validate at the seam
    },
    async close() {
      state.closed += 1;
    },
  };
  return {
    backend,
    events,
    opened,
    get closed() {
      return state.closed;
    },
  };
}

async function driveOneStepRun(observer: ReturnType<typeof createLoggingObserver>): Promise<void> {
  await observer.runStarted?.({ runId: "root-1", input: {}, worker: { type: "engine" } });
  await observer.stepStarted?.({
    runId: "step-1",
    parentRunId: "root-1",
    nodeId: "greet",
    stepType: "binary",
    worker: { type: "engine" },
    input: "hi",
  });
  await observer.stepFinished?.({ runId: "step-1", status: "succeeded", output: "hi" });
  await observer.runFinished?.({ runId: "root-1", status: "succeeded", output: {} });
}

describe("createLoggingObserver", () => {
  it("emits the root and step lifecycle as ordered, monotonic-seq events and opens/closes the backend once", async () => {
    const rec = recordingBackend();
    await driveOneStepRun(createLoggingObserver([rec.backend]));

    expect(rec.opened).toEqual(["root-1"]);
    expect(rec.closed).toBe(1);
    expect(rec.events.map((e) => [e.type, e.run_id, e.node_id])).toEqual([
      ["step-started", "root-1", null], // root is the implicit root workflow-step
      ["step-started", "step-1", "greet"],
      ["step-finished", "step-1", "greet"], // step-finished recovers node_id from step-started
      ["step-finished", "root-1", null],
    ]);
    expect(rec.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("carries step_type and worker on step-started and the error message on a failed step-finished", async () => {
    const rec = recordingBackend();
    const observer = createLoggingObserver([rec.backend]);
    await observer.runStarted?.({ runId: "root-1", input: {}, worker: { type: "engine" } });
    await observer.stepStarted?.({
      runId: "step-1",
      parentRunId: "root-1",
      nodeId: "boom",
      stepType: "binary",
      worker: { type: "llm", model: "claude" },
      input: {},
    });
    await observer.stepFinished?.({ runId: "step-1", status: "failed", error: 'step "boom" exited with code 3' });
    await observer.runFinished?.({ runId: "root-1", status: "failed", error: 'step "boom" exited with code 3' });

    const step = rec.events.find((e) => e.run_id === "step-1" && e.type === "step-started");
    expect(step).toMatchObject({ step_type: "binary", worker: { type: "llm", model: "claude" } });
    const finished = rec.events.find((e) => e.run_id === "step-1" && e.type === "step-finished");
    expect(finished).toMatchObject({ status: "failed", error: 'step "boom" exited with code 3' });
  });

  it("fans out identical narratives to every backend", async () => {
    const a = recordingBackend();
    const b = recordingBackend();
    await driveOneStepRun(createLoggingObserver([a.backend, b.backend]));
    expect(a.events).toEqual(b.events);
    expect(a.events).toHaveLength(4);
  });

  it("throws when an active backend write fails (audit-first: the run must fail)", async () => {
    const failing: LogBackend = {
      open: vi.fn(async () => {}),
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
      close: vi.fn(async () => {}),
    };
    const observer = createLoggingObserver([failing]);
    // The very first event (the root step-started) can't be written → the hook rejects so
    // runWorkflow fails the run.
    await expect(
      observer.runStarted?.({ runId: "root-1", input: {}, worker: { type: "engine" } }),
    ).rejects.toThrow(/disk full/);
  });

  it("still emits terminal events to a surviving backend after another backend fails", async () => {
    const survivor = recordingBackend();
    const failing: LogBackend = {
      async open() {},
      async write(event) {
        if (event.type === "step-started" && event.run_id === "step-1") throw new Error("disk full");
      },
      async close() {},
    };
    const observer = createLoggingObserver([failing, survivor.backend]);
    await observer.runStarted?.({ runId: "root-1", input: {}, worker: { type: "engine" } });
    // the run is now failing; runWorkflow drives the terminal event next
    await Promise.resolve(
      observer.stepStarted?.({ runId: "step-1", parentRunId: "root-1", nodeId: "greet", stepType: "binary", worker: { type: "engine" }, input: {} }),
    ).catch(() => {});
    await observer.runFinished?.({ runId: "root-1", status: "failed", error: "log backend write failed" });

    // The survivor got everything up to and including the terminal root step-finished, and closed.
    expect(survivor.closed).toBe(1);
    expect(survivor.events.some((e) => e.type === "step-finished" && e.run_id === "root-1")).toBe(true);
  });

  it("runFinished is idempotent — a second call emits nothing and does not re-close", async () => {
    const rec = recordingBackend();
    const observer = createLoggingObserver([rec.backend]);
    await observer.runStarted?.({ runId: "root-1", input: {}, worker: { type: "engine" } });
    await observer.runFinished?.({ runId: "root-1", status: "failed", error: "x" });
    const eventCount = rec.events.length;
    await observer.runFinished?.({ runId: "root-1", status: "failed", error: "x" });
    expect(rec.events).toHaveLength(eventCount);
    expect(rec.closed).toBe(1);
  });
});
