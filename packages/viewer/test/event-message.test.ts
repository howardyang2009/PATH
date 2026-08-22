import type { LogEvent } from "@path/client-core";
import { describe, expect, it } from "vitest";
import { eventMessage } from "../src/event-message.js";

/**
 * The shared envelope every log event carries (mvp spec §8.1); each case spreads its own payload on.
 * `node_id` is the GUID and `node_name` the human label — a narrative row shows both, so the two are
 * given distinct values here rather than the same string.
 */
const ENVELOPE = { seq: 1, ts: "2026-07-25T10:00:00.000Z", run_id: "run_a", node_id: "n1", node_name: "step-a" } as const;

/** The trace type as it rides the event stream; derived rather than re-declared so it cannot drift. */
type Trace = Extract<LogEvent, { type: "checkpoint-passed" }>["trace"];

/** A condition trace stands in for the real one — neither the row nor the outcome renders it. */
const TRACE: Trace = { type: "exists", path: "output.status", outcome: "true" };

describe("eventMessage", () => {
  it("names the step by its human name and id, plus its worker, on step-started", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-started", step_type: "binary", worker: { type: "engine" } })).toBe(
      "step-a (n1) started · engine",
    );
  });

  it("labels the implicit root step's events as the root", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: null,
        node_name: null,
        type: "step-started",
        step_type: "workflow",
        worker: { type: "engine" },
      }),
    ).toBe("root started · engine");
  });

  it("carries the failure message on a failed step-finished", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-finished", status: "failed", error: "exit 1: boom" })).toBe(
      "step-a (n1) failed · exit 1: boom",
    );
  });

  it("says only the outcome when a step finished without an error", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-finished", status: "succeeded" })).toBe("step-a (n1) succeeded");
  });

  it("reports checkpoint verdicts", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "n2", node_name: "gate", type: "checkpoint-passed", trace: TRACE })).toBe(
      "checkpoint gate (n2) passed",
    );
    expect(eventMessage({ ...ENVELOPE, node_id: "n2", node_name: "gate", type: "checkpoint-failed", trace: TRACE })).toBe(
      "checkpoint gate (n2) failed",
    );
  });

  it("names the arm a branch took, including the else fallback", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "n3", node_name: "route", type: "branch-taken", arm: 0, trace: TRACE })).toBe(
      "branch route (n3) took arm 0",
    );
    // The fallback arm has no condition of its own, so it carries no trace.
    expect(eventMessage({ ...ENVELOPE, node_id: "n3", node_name: "route", type: "branch-taken", arm: "else", trace: null })).toBe(
      "branch route (n3) took the else arm",
    );
    expect(eventMessage({ ...ENVELOPE, node_id: "n3", node_name: "route", type: "branch-no-match", traces: [TRACE] })).toBe(
      "branch route (n3) matched no arm",
    );
  });

  it("lists the branches a collect join applied and the context keys they published", () => {
    expect(
      eventMessage({ ...ENVELOPE, node_id: "n4", node_name: "fan", type: "join-applied", branches: ["a", "b"], published_keys: ["notes"] }),
    ).toBe("join fan (n4) applied · branches a, b · published notes");
  });

  it("says nothing about published keys when a join published none", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "n4", node_name: "fan", type: "join-applied", branches: ["a"], published_keys: [] })).toBe(
      "join fan (n4) applied · branches a",
    );
  });

  it("names the sibling run that caused a cancellation", () => {
    expect(eventMessage({ ...ENVELOPE, type: "run-cancelled", cause: "sibling-failed", cause_run_id: "run_b" })).toBe(
      "step-a (n1) cancelled · cause run_b",
    );
  });

  it("attributes an operator cancel to the operator, not a sibling run", () => {
    expect(eventMessage({ ...ENVELOPE, type: "run-cancelled", cause: "operator", cause_run_id: null })).toBe(
      "step-a (n1) cancelled by the operator",
    );
  });

  it("counts while-do iterations and reports why the loop exited", () => {
    expect(eventMessage({ ...ENVELOPE, node_id: "n5", node_name: "revise", type: "iteration-started", iteration: 2, trace: TRACE })).toBe(
      "while-do revise (n5) iteration 2",
    );
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n5",
        node_name: "revise",
        type: "loop-exited",
        reason: "max-iterations-exceeded",
        iterations: 3,
        trace: TRACE,
      }),
    ).toBe("while-do revise (n5) exited after 3 iterations · max-iterations-exceeded");
  });
});
