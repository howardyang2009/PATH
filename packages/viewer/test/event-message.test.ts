import type { LogEvent } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { eventMessage } from "../src/event-message.js";

/** The shared envelope every log event carries (mvp spec §8.1); each case spreads its own payload on. */
const ENVELOPE = { seq: 1, ts: "2026-07-25T10:00:00.000Z", run_id: "run_a", node_id: "step-a", node_name: "step-a" } as const;

/** The trace type as it rides the event stream; derived rather than re-declared so it cannot drift. */
type Trace = Extract<LogEvent, { type: "checkpoint-passed" }>["trace"];

/** A condition trace stands in for the real one — neither the row nor the outcome renders it. */
const TRACE: Trace = { type: "exists", path: "output.status", outcome: "true" };

describe("eventMessage", () => {
  it("names the step and its worker on step-started", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-started", step_type: "binary", worker: { type: "engine" } })).toBe(
      "step-a started · engine",
    );
  });

  it("labels the implicit root step's events as the root", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: null,
        type: "step-started",
        step_type: "workflow",
        worker: { type: "engine" },
      }),
    ).toBe("root started · engine");
  });

  it("carries the failure message on a failed step-finished", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-finished", status: "failed", error: "exit 1: boom" })).toBe(
      "step-a failed · exit 1: boom",
    );
  });

  it("says only the outcome when a step finished without an error", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-finished", status: "succeeded" })).toBe("step-a succeeded");
  });

  it("reports checkpoint verdicts", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "gate", type: "checkpoint-passed", trace: TRACE })).toBe(
      "checkpoint gate passed",
    );
    expect(eventMessage({ ...ENVELOPE, node_id: "gate", type: "checkpoint-failed", trace: TRACE })).toBe(
      "checkpoint gate failed",
    );
  });

  it("names the arm a branch took, including the else fallback", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "route", type: "branch-taken", arm: 0, trace: TRACE })).toBe(
      "branch route took arm 0",
    );
    // The fallback arm has no condition of its own, so it carries no trace.
    expect(eventMessage({ ...ENVELOPE, node_id: "route", type: "branch-taken", arm: "else", trace: null })).toBe(
      "branch route took the else arm",
    );
    expect(eventMessage({ ...ENVELOPE, node_id: "route", type: "branch-no-match", traces: [TRACE] })).toBe(
      "branch route matched no arm",
    );
  });

  it("lists the branches a collect join applied and the context keys they published", () => {
    expect(
      eventMessage({ ...ENVELOPE, node_id: "fan", type: "join-applied", branches: ["a", "b"], published_keys: ["notes"] }),
    ).toBe("join fan applied · branches a, b · published notes");
  });

  it("says nothing about published keys when a join published none", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "fan", type: "join-applied", branches: ["a"], published_keys: [] })).toBe(
      "join fan applied · branches a",
    );
  });

  it("names the sibling run that caused a cancellation", () => {
    expect(eventMessage({ ...ENVELOPE, type: "run-cancelled", cause: "sibling-failed", cause_run_id: "run_b" })).toBe(
      "step-a cancelled · cause run_b",
    );
  });

  it("attributes an operator cancel to the operator, not a sibling run", () => {
    expect(eventMessage({ ...ENVELOPE, type: "run-cancelled", cause: "operator", cause_run_id: null })).toBe(
      "step-a cancelled by the operator",
    );
  });

  it("counts while-do iterations and reports why the loop exited", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "revise", type: "iteration-started", iteration: 2, trace: TRACE })).toBe(
      "while-do revise iteration 2",
    );
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "revise",
        type: "loop-exited",
        reason: "max-iterations-exceeded",
        iterations: 3,
        trace: TRACE,
      }),
    ).toBe("while-do revise exited after 3 iterations · max-iterations-exceeded");
  });
});
