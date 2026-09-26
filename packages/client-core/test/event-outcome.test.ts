import type { LogEvent } from "@path/schema";
import { describe, expect, it } from "vitest";
import { eventOutcome, isRootRunFinished, runStatusAfter } from "../src/event-outcome.js";

const ENVELOPE = {
  seq: 1,
  ts: "2026-07-25T10:00:00.000Z",
  run_id: "run_a",
  node_id: "step-a",
  node_name: "step-a",
} as const;

/** The trace type as it rides the event stream; derived rather than re-declared so it cannot drift. */
type Trace = Extract<LogEvent, { type: "checkpoint-passed" }>["trace"];

/** A condition trace stands in for the real one — neither the row nor the outcome renders it. */
const TRACE: Trace = { type: "exists", path: "output.status", outcome: "true" };

describe("eventOutcome", () => {
  it("reads a step's own outcome off step-finished", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "failed" })).toBe("failed");
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "succeeded" })).toBe(
      "succeeded",
    );
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "cancelled" })).toBe(
      "cancelled",
    );
  });

  it("treats a started step as running", () => {
    expect(
      eventOutcome({
        ...ENVELOPE,
        type: "step-started",
        step_type: "binary",
        worker_name: "spawn",
      }),
    ).toBe("running");
  });

  it("counts the engine constructs that stop a run as failures", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "checkpoint-failed", trace: TRACE })).toBe("failed");
    expect(eventOutcome({ ...ENVELOPE, type: "branch-no-match", traces: [TRACE] })).toBe("failed");
    // A while-do that exceeds its mandatory max-iterations bound fails the run (CONTEXT.md, Controller).
    expect(
      eventOutcome({
        ...ENVELOPE,
        type: "loop-exited",
        reason: "max-iterations-exceeded",
        iterations: 3,
        trace: TRACE,
      }),
    ).toBe("failed");
  });

  it("gives routing and coordination events no outcome", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "branch-taken", arm: 0, trace: TRACE })).toBeNull();
    expect(
      eventOutcome({ ...ENVELOPE, type: "join-applied", branches: ["a"], published_keys: [] }),
    ).toBeNull();
    expect(
      eventOutcome({ ...ENVELOPE, type: "iteration-started", iteration: 1, trace: TRACE }),
    ).toBeNull();
    // A loop that exited because its condition went false ended normally.
    expect(
      eventOutcome({
        ...ENVELOPE,
        type: "loop-exited",
        reason: "condition-false",
        iterations: 2,
        trace: TRACE,
      }),
    ).toBeNull();
  });

  it("routes an exhausted goto to failed, and a pass or a jump to no outcome (G-V-02)", () => {
    const target = { target_node_id: "n2", target_node_name: "b" };
    expect(
      eventOutcome({ ...ENVELOPE, type: "goto-exhausted", ...target, max_jumps: 3, pass: 4 }),
    ).toBe("failed");
    expect(
      eventOutcome({ ...ENVELOPE, type: "goto-taken", ...target, jump: 1, max_jumps: 3, pass: 2 }),
    ).toBeNull();
    expect(eventOutcome({ ...ENVELOPE, type: "pass-started", pass: 2 })).toBeNull();
  });

  it("reports a cancelled run as cancelled, not failed", () => {
    expect(
      eventOutcome({
        ...ENVELOPE,
        type: "run-cancelled",
        cause: "sibling-failed",
        cause_run_id: "run_b",
      }),
    ).toBe("cancelled");
  });

  it("passes a checkpoint verdict through as a success", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "checkpoint-passed", trace: TRACE })).toBe(
      "succeeded",
    );
  });
});

describe("runStatusAfter", () => {
  it("walks a live run to running on its own step-started", () => {
    const event: LogEvent = {
      ...ENVELOPE,
      type: "step-started",
      step_type: "binary",
      worker_name: "spawn",
    };
    expect(runStatusAfter("pending", event)).toBe("running");
  });

  it("does not walk a terminal run backward on a replayed step-started", () => {
    const event: LogEvent = {
      ...ENVELOPE,
      type: "step-started",
      step_type: "binary",
      worker_name: "spawn",
    };
    expect(runStatusAfter("succeeded", event)).toBe("succeeded");
    expect(runStatusAfter("failed", event)).toBe("failed");
    expect(runStatusAfter("cancelled", event)).toBe("cancelled");
  });

  it("parks a live run on awaiting, and never reopens one a Complete already finished", () => {
    const event: LogEvent = { ...ENVELOPE, type: "step-awaiting", assignee: null };
    expect(runStatusAfter("running", event)).toBe("awaiting");
    expect(runStatusAfter("succeeded", event)).toBe("succeeded");
  });

  it("takes a step-finished verdict as the run's status, and leaves other events alone", () => {
    const finished: LogEvent = {
      ...ENVELOPE,
      type: "step-finished",
      status: "failed",
      error: "boom",
    };
    expect(runStatusAfter("running", finished)).toBe("failed");
    expect(eventOutcome(finished)).toBe("failed");
    // A control-node event owns no run of its own, so it moves no run's status.
    expect(
      runStatusAfter("running", { ...ENVELOPE, type: "branch-taken", arm: 0, trace: TRACE }),
    ).toBe("running");
  });
});

describe("isRootRunFinished", () => {
  it("is true only for the root run's own node-less finish", () => {
    const rootFinish: LogEvent = {
      ...ENVELOPE,
      run_id: "root",
      node_id: null,
      type: "step-finished",
      status: "succeeded",
    };
    expect(isRootRunFinished(rootFinish, "root")).toBe(true);
    // A leaf's finish carries the leaf's node id.
    expect(
      isRootRunFinished(
        {
          ...ENVELOPE,
          run_id: "root",
          node_id: "step-a",
          type: "step-finished",
          status: "succeeded",
        },
        "root",
      ),
    ).toBe(false);
    // A nested workflow-run's finish is not the tree's own.
    expect(
      isRootRunFinished(
        { ...ENVELOPE, run_id: "child", node_id: null, type: "step-finished", status: "succeeded" },
        "root",
      ),
    ).toBe(false);
    expect(
      isRootRunFinished(
        { ...ENVELOPE, run_id: "root", node_id: null, type: "step-awaiting", assignee: null },
        "root",
      ),
    ).toBe(false);
  });
});
