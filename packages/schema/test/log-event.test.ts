import { describe, expect, it } from "vitest";
import { LogEventSchema } from "../src/log-event.js";

const envelope = {
  seq: 1,
  ts: "2026-07-19T00:00:00.000Z",
  run_id: "run-1",
  node_id: "greet",
  node_name: "greet",
};

describe("LogEventSchema", () => {
  it("accepts a step-started event with its worker_name and step_type payload", () => {
    const parsed = LogEventSchema.parse({
      type: "step-started",
      ...envelope,
      step_type: "binary",
      worker_name: "spawn",
    });
    expect(parsed.type).toBe("step-started");
  });

  it("accepts a succeeded step-finished event with no error", () => {
    const parsed = LogEventSchema.parse({
      type: "step-finished",
      ...envelope,
      status: "succeeded",
    });
    expect(parsed).toMatchObject({ type: "step-finished", status: "succeeded" });
  });

  it("accepts a failed step-finished event carrying the error message", () => {
    const parsed = LogEventSchema.parse({
      type: "step-finished",
      ...envelope,
      status: "failed",
      error: 'step "boom" exited with code 3',
    });
    expect(parsed).toMatchObject({ status: "failed", error: 'step "boom" exited with code 3' });
  });

  it("allows a null node_id + node_name for the root workflow-step", () => {
    const parsed = LogEventSchema.parse({
      type: "step-started",
      ...envelope,
      node_id: null,
      node_name: null,
      step_type: "workflow",
      worker_name: "workflow",
    });
    expect(parsed.node_id).toBeNull();
    expect(parsed.node_name).toBeNull();
  });

  it("carries the cause of an operator cancellation, which has no cause run behind it (#52)", () => {
    const parsed = LogEventSchema.parse({
      type: "run-cancelled",
      ...envelope,
      cause: "operator",
      cause_run_id: null,
    });
    expect(parsed).toMatchObject({ type: "run-cancelled", cause: "operator", cause_run_id: null });
  });

  it("carries the sibling-succeeded cause of a wait-one loser, which has no cause run behind it", () => {
    const parsed = LogEventSchema.parse({
      type: "run-cancelled",
      ...envelope,
      cause: "sibling-succeeded",
      cause_run_id: null,
    });
    expect(parsed).toMatchObject({
      type: "run-cancelled",
      cause: "sibling-succeeded",
      cause_run_id: null,
    });
  });

  it("carries the winner name on a wait-one join-applied event", () => {
    const parsed = LogEventSchema.parse({
      type: "join-applied",
      ...envelope,
      branches: ["fast"],
      published_keys: ["answer"],
      winner: "fast",
    });
    expect(parsed).toMatchObject({ type: "join-applied", winner: "fast" });
  });

  it("omits winner on a collect join-applied event", () => {
    const parsed = LogEventSchema.parse({
      type: "join-applied",
      ...envelope,
      branches: ["a", "b"],
      published_keys: [],
    });
    expect(parsed).not.toHaveProperty("winner");
  });

  it("reads a pre-#52 run-cancelled line — written with no cause — back as sibling-failed", () => {
    // Every persisted NDJSON line is re-validated on replay (readNdjsonLog), so a v0.3-era log must
    // keep parsing: `cause` defaults to the only cause that existed when it was written.
    const parsed = LogEventSchema.parse({
      type: "run-cancelled",
      ...envelope,
      cause_run_id: "run-2",
    });
    expect(parsed).toMatchObject({
      type: "run-cancelled",
      cause: "sibling-failed",
      cause_run_id: "run-2",
    });
  });

  it("carries the assignee on a step-awaiting event (#488)", () => {
    const parsed = LogEventSchema.parse({ type: "step-awaiting", ...envelope, assignee: "alex" });
    expect(parsed).toMatchObject({ type: "step-awaiting", assignee: "alex" });
  });

  it("accepts a step-awaiting event that named no assignee", () => {
    const parsed = LogEventSchema.parse({ type: "step-awaiting", ...envelope, assignee: null });
    expect(parsed).toMatchObject({ type: "step-awaiting", assignee: null });
  });

  it("reads a pre-#488 step-awaiting line — written with no assignee — back as null", () => {
    // Every persisted NDJSON line is re-validated on replay, so a line written before the field
    // existed must keep parsing: `assignee` defaults to null.
    const parsed = LogEventSchema.parse({ type: "step-awaiting", ...envelope });
    expect(parsed).toMatchObject({ type: "step-awaiting", assignee: null });
  });

  it("accepts the goto events (spec docs/spec/goto.md §7)", () => {
    const goto = { ...envelope, node_id: "g1", node_name: "check" };
    expect(
      LogEventSchema.parse({
        type: "pass-started",
        ...envelope,
        node_id: null,
        node_name: null,
        pass: 1,
      }),
    ).toMatchObject({ pass: 1 });
    expect(LogEventSchema.parse({ type: "pass-started", ...goto, pass: 2 })).toMatchObject({
      node_name: "check",
      pass: 2,
    });
    const target = { target_node_id: "n2", target_node_name: "b" };
    expect(
      LogEventSchema.parse({
        type: "goto-taken",
        ...goto,
        ...target,
        jump: 2,
        max_jumps: 3,
        pass: 3,
      }),
    ).toMatchObject({ jump: 2 });
    expect(
      LogEventSchema.parse({ type: "goto-exhausted", ...goto, ...target, max_jumps: 3, pass: 4 }),
    ).toMatchObject({ pass: 4 });
    // No jump happens on exhaustion, so the payload has no `jump`.
    expect(() =>
      LogEventSchema.parse({
        type: "goto-exhausted",
        ...goto,
        ...target,
        jump: 4,
        max_jumps: 3,
        pass: 4,
      }),
    ).toThrow();
  });

  it("G-V-03: reads a pre-goto run.log, holding none of the goto events, unchanged", () => {
    const lines = [
      {
        type: "step-started",
        ...envelope,
        seq: 1,
        node_id: null,
        node_name: null,
        step_type: "workflow",
        worker_name: "workflow",
      },
      { type: "step-started", ...envelope, seq: 2, step_type: "prompt", worker_name: "anthropic" },
      { type: "step-finished", ...envelope, seq: 3, status: "succeeded" },
      { type: "branch-taken", ...envelope, seq: 4, arm: "else", trace: null },
      {
        type: "step-finished",
        ...envelope,
        seq: 5,
        node_id: null,
        node_name: null,
        status: "succeeded",
      },
    ];
    expect(lines.map((line) => LogEventSchema.parse(JSON.parse(JSON.stringify(line))))).toEqual(
      lines,
    );
  });

  it("rejects an unknown event type", () => {
    expect(() => LogEventSchema.parse({ type: "branch-taken", ...envelope })).toThrow();
  });

  it("rejects an event missing its seq (the ordering truth)", () => {
    expect(() =>
      LogEventSchema.parse({
        type: "step-finished",
        ts: envelope.ts,
        run_id: "r",
        node_id: null,
        status: "succeeded",
      }),
    ).toThrow();
  });

  it("rejects an unexpected extra field (strict envelope)", () => {
    expect(() =>
      LogEventSchema.parse({
        type: "step-finished",
        ...envelope,
        status: "succeeded",
        bogus: true,
      }),
    ).toThrow();
  });
});
