import type { LogEvent } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { eventOutcome } from "../src/event-outcome.js";

const ENVELOPE = { seq: 1, ts: "2026-07-25T10:00:00.000Z", run_id: "run_a", node_id: "step-a" } as const;

/** The trace type as it rides the event stream; derived rather than re-declared so it cannot drift. */
type Trace = Extract<LogEvent, { type: "checkpoint-passed" }>["trace"];

/** A condition trace stands in for the real one — neither the row nor the outcome renders it. */
const TRACE: Trace = { type: "exists", path: "output.status", outcome: "true" };

describe("eventOutcome", () => {
  it("reads a step's own outcome off step-finished", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "failed" })).toBe("failed");
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "succeeded" })).toBe("succeeded");
    expect(eventOutcome({ ...ENVELOPE, type: "step-finished", status: "cancelled" })).toBe("cancelled");
  });

  it("treats a started step as running", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "step-started", step_type: "binary", worker: { type: "engine" } })).toBe(
      "running",
    );
  });

  it("counts the engine constructs that stop a run as failures", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "checkpoint-failed", trace: TRACE })).toBe("failed");
    expect(eventOutcome({ ...ENVELOPE, type: "branch-no-match", traces: [TRACE] })).toBe("failed");
    // A while-do that exceeds its mandatory max-iterations bound fails the run (CONTEXT.md, Logicer).
    expect(
      eventOutcome({ ...ENVELOPE, type: "loop-exited", reason: "max-iterations-exceeded", iterations: 3, trace: TRACE }),
    ).toBe("failed");
  });

  it("gives routing and coordination events no outcome", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "branch-taken", arm: 0, trace: TRACE })).toBeNull();
    expect(eventOutcome({ ...ENVELOPE, type: "join-applied", branches: ["a"], published_keys: [] })).toBeNull();
    expect(eventOutcome({ ...ENVELOPE, type: "iteration-started", iteration: 1, trace: TRACE })).toBeNull();
    // A loop that exited because its condition went false ended normally.
    expect(
      eventOutcome({ ...ENVELOPE, type: "loop-exited", reason: "condition-false", iterations: 2, trace: TRACE }),
    ).toBeNull();
  });

  it("reports a cancelled run as cancelled, not failed", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "run-cancelled", cause: "sibling-failed", cause_run_id: "run_b" })).toBe("cancelled");
  });

  it("passes a checkpoint verdict through as a success", () => {
    expect(eventOutcome({ ...ENVELOPE, type: "checkpoint-passed", trace: TRACE })).toBe("succeeded");
  });
});
