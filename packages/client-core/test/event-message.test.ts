import { verbatim } from "@path/i18n";
import type { LogEvent } from "@path/schema";
import { describe, expect, it } from "vitest";
import { eventMessage } from "../src/event-message.js";

/**
 * The shared envelope every log event carries (mvp spec §8.1); each case spreads its own payload
 * on. `node_id` is the GUID and `node_name` the human label — a narrative row shows both, so the
 * two are given distinct values here rather than the same string.
 */
const ENVELOPE = {
  seq: 1,
  ts: "2026-07-25T10:00:00.000Z",
  run_id: "run_a",
  node_id: "n1",
  node_name: "step-a",
} as const;

/** The trace type as it rides the event stream; derived rather than re-declared so it cannot
 * drift. */
type Trace = Extract<LogEvent, { type: "checkpoint-passed" }>["trace"];

/** A condition trace stands in for the real one — neither the row nor the outcome renders it. */
const TRACE: Trace = { type: "exists", path: "previous.status", outcome: "true" };

describe("eventMessage", () => {
  it("names the step by its human name and id, plus its worker, on step-started", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        type: "step-started",
        step_type: "binary",
        worker_name: "spawn",
      }),
    ).toEqual({ key: "events.stepStarted", params: { label: "step-a (n1)", worker: "spawn" } });
  });

  it("labels the implicit root step's events as the root", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: null,
        node_name: null,
        type: "step-started",
        step_type: "workflow",
        worker_name: "workflow",
      }),
    ).toEqual({
      key: "events.stepStarted",
      params: { label: { key: "events.root" }, worker: "workflow" },
    });
  });

  it("carries the failure message on a failed step-finished", () => {
    expect(
      eventMessage({ ...ENVELOPE, type: "step-finished", status: "failed", error: "exit 1: boom" }),
    ).toEqual({
      key: "events.stepFinishedError",
      params: {
        label: "step-a (n1)",
        status: { key: "shared.status.failed" },
        error: verbatim("exit 1: boom"),
      },
    });
  });

  it("says only the outcome when a step finished without an error", () => {
    expect(eventMessage({ ...ENVELOPE, type: "step-finished", status: "succeeded" })).toEqual({
      key: "events.stepFinished",
      params: { label: "step-a (n1)", status: { key: "shared.status.succeeded" } },
    });
  });

  it("reports checkpoint verdicts", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n2",
        node_name: "gate",
        type: "checkpoint-passed",
        trace: TRACE,
      }),
    ).toEqual({ key: "events.checkpointPassed", params: { label: "gate (n2)" } });
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n2",
        node_name: "gate",
        type: "checkpoint-failed",
        trace: TRACE,
      }),
    ).toEqual({ key: "events.checkpointFailed", params: { label: "gate (n2)" } });
  });

  it("names the arm a branch took, including the else fallback", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n3",
        node_name: "route",
        type: "branch-taken",
        arm: 0,
        trace: TRACE,
      }),
    ).toEqual({ key: "events.branchTookArm", params: { label: "route (n3)", arm: 0 } });
    // The fallback arm has no condition of its own, so it carries no trace.
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n3",
        node_name: "route",
        type: "branch-taken",
        arm: "else",
        trace: null,
      }),
    ).toEqual({ key: "events.branchTookElse", params: { label: "route (n3)" } });
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n3",
        node_name: "route",
        type: "branch-no-match",
        traces: [TRACE],
      }),
    ).toEqual({ key: "events.branchNoMatch", params: { label: "route (n3)" } });
  });

  it("lists the branches a collect join applied and the context keys they published", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n4",
        node_name: "fan",
        type: "join-applied",
        branches: ["a", "b"],
        published_keys: ["notes"],
      }),
    ).toEqual({
      key: "events.joinAppliedPublished",
      params: { label: "fan (n4)", branches: "a, b", keys: "notes" },
    });
  });

  it("says nothing about published keys when a join published none", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n4",
        node_name: "fan",
        type: "join-applied",
        branches: ["a"],
        published_keys: [],
      }),
    ).toEqual({ key: "events.joinApplied", params: { label: "fan (n4)", branches: "a" } });
  });

  it("names the sibling run that caused a cancellation", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        type: "run-cancelled",
        cause: "sibling-failed",
        cause_run_id: "run_b",
      }),
    ).toEqual({
      key: "events.cancelledByRun",
      params: { label: "step-a (n1)", causeRunId: "run_b" },
    });
  });

  it("attributes an operator cancel to the operator, not a sibling run", () => {
    expect(
      eventMessage({ ...ENVELOPE, type: "run-cancelled", cause: "operator", cause_run_id: null }),
    ).toEqual({ key: "events.cancelledByOperator", params: { label: "step-a (n1)" } });
  });

  it("counts while-do iterations and reports why the loop exited", () => {
    expect(
      eventMessage({
        ...ENVELOPE,
        node_id: "n5",
        node_name: "revise",
        type: "iteration-started",
        iteration: 2,
        trace: TRACE,
      }),
    ).toEqual({
      key: "events.iterationStarted",
      params: { label: "revise (n5)", iteration: 2 },
    });
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
    ).toEqual({
      key: "events.loopExited",
      params: {
        label: "revise (n5)",
        iterations: 3,
        reason: { key: "events.loopExitReason.maxIterationsExceeded" },
      },
    });
  });
});

describe("eventMessage — goto (spec docs/spec/goto.md §7, G-V-02)", () => {
  const GOTO = { ...ENVELOPE, node_id: null, node_name: "check" } as const;

  it("narrates a jump with its count, bound and the pass it opens", () => {
    expect(
      eventMessage({
        ...GOTO,
        type: "goto-taken",
        target_node_id: "n2",
        target_node_name: "B",
        jump: 2,
        max_jumps: 3,
        pass: 3,
      }),
    ).toEqual({
      key: "events.gotoTaken",
      params: { label: "check", target: "B", jump: 2, maxJumps: 3, pass: 3 },
    });
  });

  it("narrates an exhausted goto with its bound and target", () => {
    expect(
      eventMessage({
        ...GOTO,
        type: "goto-exhausted",
        target_node_id: "n2",
        target_node_name: "B",
        max_jumps: 3,
        pass: 4,
      }),
    ).toEqual({
      key: "events.gotoExhausted",
      params: { label: "check", maxJumps: 3, target: "B" },
    });
  });

  it("names the goto that opened a pass, and pass 1 by its ordinal alone", () => {
    expect(eventMessage({ ...GOTO, node_id: "g1", type: "pass-started", pass: 2 })).toEqual({
      key: "events.passOpenedBy",
      params: { pass: 2, label: "check (g1)" },
    });
    expect(
      eventMessage({ ...ENVELOPE, node_id: null, node_name: null, type: "pass-started", pass: 1 }),
    ).toEqual({ key: "events.passStarted", params: { pass: 1 } });
  });
});
