import { describe, expect, it } from "vitest";
import type { Trace } from "../src/condition.js";
import type { RunEvent, RunPayload, UnsequencedLogEvent } from "../src/run-observer.js";
import { collectSecrets, maskRunEvent } from "../src/secret-mask.js";

const masker = collectSecrets([{ token: { $secret: "s3cret-value" } }]);
const TOKEN = "[secret:token]";

// The envelope every log event carries: its run and the node it is about.
const env = { ts: "2026-01-01T00:00:00.000Z", run_id: "r1", node_id: "n1", node_name: "n1" };

/** Every log event type, so a member added without a masking decision fails to compile here. */
const EVENTS: { [K in UnsequencedLogEvent["type"]]: Extract<UnsequencedLogEvent, { type: K }> } = {
  "step-started": { type: "step-started", ...env, step_type: "binary", worker_name: "spawn" },
  "step-finished": {
    type: "step-finished",
    ...env,
    status: "failed",
    error: "died on s3cret-value",
  },
  "checkpoint-passed": {
    type: "checkpoint-passed",
    ...env,
    trace: { type: "equals", path: "context.k", outcome: "true", value: "s3cret-value" },
  },
  "checkpoint-failed": {
    type: "checkpoint-failed",
    ...env,
    trace: { type: "equals", path: "context.k", outcome: "false", value: "s3cret-value" },
  },
  "branch-taken": {
    type: "branch-taken",
    ...env,
    arm: 0,
    trace: { type: "equals", path: "context.k", outcome: "true", value: "s3cret-value" },
  },
  "branch-no-match": {
    type: "branch-no-match",
    ...env,
    traces: [{ type: "equals", path: "context.k", outcome: "false", value: "s3cret-value" }],
  },
  "iteration-started": {
    type: "iteration-started",
    ...env,
    iteration: 1,
    trace: { type: "exists", path: "context.k", outcome: "true", value: "s3cret-value" },
  },
  "loop-exited": {
    type: "loop-exited",
    ...env,
    reason: "condition-false",
    iterations: 2,
    trace: { type: "exists", path: "context.k", outcome: "false", value: "s3cret-value" },
  },
  "join-applied": { type: "join-applied", ...env, branches: ["a"], published_keys: ["k"] },
  "run-cancelled": { type: "run-cancelled", ...env, cause: "operator", cause_run_id: null },
  "reuse-marker": { type: "reuse-marker", ...env, original_run_id: "orig-run" },
  "pass-started": { type: "pass-started", ...env, pass: 2 },
  "goto-taken": {
    type: "goto-taken",
    ...env,
    target_node_id: "n2",
    target_node_name: "n2",
    jump: 1,
    max_jumps: 3,
    pass: 2,
  },
  "goto-exhausted": {
    type: "goto-exhausted",
    ...env,
    target_node_id: "n2",
    target_node_name: "n2",
    max_jumps: 3,
    pass: 4,
  },
  // `assignee` is an interpolated author value, so it can reach a secret and must be scrubbed.
  "step-awaiting": { type: "step-awaiting", ...env, assignee: "s3cret-value" },
};

/** Every payload kind, for the same reason. */
const PAYLOADS: { [K in RunPayload["kind"]]: Extract<RunPayload, { kind: K }> } = {
  started: { kind: "started", parentRunId: "r0", input: { k: "s3cret-value" } },
  output: { kind: "output", output: { k: "s3cret-value" } },
  stderr: { kind: "stderr", stderr: "boom s3cret-value" },
  usage: { kind: "usage", usage: { in: 1, note: "s3cret-value" }, estimatedCostUsd: 0.01 },
  context: { kind: "context", context: { k: "s3cret-value" } },
};

/**
 * The events that provably cannot carry a secret: every field is an id, name, count, context key or
 * an enum value the engine chose — never a config value. Naming them stops the sweep below from
 * passing vacuously: any *other* member whose sample does not really hold a secret proves nothing.
 */
const CANNOT_CARRY_A_SECRET = new Set<UnsequencedLogEvent["type"]>([
  "step-started",
  "join-applied",
  "run-cancelled",
  "reuse-marker",
  "pass-started",
  "goto-taken",
  "goto-exhausted",
]);

const ids = { runId: "r1", rootRunId: "r0" };
const narrated = (event: UnsequencedLogEvent): RunEvent => ({ ...ids, event });
const recorded = (payload: RunPayload): RunEvent => ({ ...ids, event: null, payload });
const maskedEvent = (event: UnsequencedLogEvent) => maskRunEvent(masker, narrated(event)).event;
const maskedPayload = (payload: RunPayload) => maskRunEvent(masker, recorded(payload)).payload;

describe("maskRunEvent", () => {
  it("leaves no secret in any log event type or payload kind", () => {
    for (const event of Object.values(EVENTS))
      expect(JSON.stringify(maskedEvent(event))).not.toContain("s3cret-value");
    for (const payload of Object.values(PAYLOADS))
      expect(JSON.stringify(maskedPayload(payload))).not.toContain("s3cret-value");
  });

  // Without this, a member could be listed in the switch, return unmasked, and still pass the sweep
  // above — because its sample never held a secret to begin with.
  it("proves each sweep is real: every maskable sample carries the secret before masking", () => {
    for (const [type, event] of Object.entries(EVENTS)) {
      if (CANNOT_CARRY_A_SECRET.has(type as UnsequencedLogEvent["type"])) continue;
      expect(JSON.stringify(event), `sample for "${type}" carries no secret`).toContain(
        "s3cret-value",
      );
    }
    for (const [kind, payload] of Object.entries(PAYLOADS))
      expect(JSON.stringify(payload), `sample for "${kind}" carries no secret`).toContain(
        "s3cret-value",
      );
  });

  it("masks an event and its payload together, keeping the identity", () => {
    const masked = maskRunEvent(masker, {
      ...ids,
      event: EVENTS["step-started"],
      payload: PAYLOADS.started,
    });
    expect(masked).toEqual({
      ...ids,
      event: EVENTS["step-started"],
      payload: { ...PAYLOADS.started, input: { k: TOKEN } },
    });
  });

  it("masks the frozen launch facts on a root start, config included (ADR 0046)", () => {
    // The field is optional, so the `never` guard cannot force this — this sample is the guard.
    const withFacts: RunPayload = {
      ...PAYLOADS.started,
      launchFacts: {
        input: { k: "s3cret-value" },
        config: { apiKey: "s3cret-value", plain: "visible" },
        workerDefaults: { prompt: "deepseek" },
        secretKeys: ["apiKey"],
      },
    };
    expect(maskedPayload(withFacts)).toMatchObject({
      launchFacts: {
        input: { k: TOKEN },
        config: { apiKey: TOKEN, plain: "visible" },
        workerDefaults: { prompt: "deepseek" },
        secretKeys: ["apiKey"],
      },
    });
  });

  it("masks stderr, context and a succeeded output", () => {
    expect(maskedPayload(PAYLOADS.stderr)).toMatchObject({ stderr: `boom ${TOKEN}` });
    expect(maskedPayload(PAYLOADS.context)).toMatchObject({ context: { k: TOKEN } });
    expect(maskedPayload(PAYLOADS.output)).toMatchObject({ output: { k: TOKEN } });
  });

  it("masks a failed error, and leaves a cancelled finish alone", () => {
    expect(maskedEvent(EVENTS["step-finished"])).toMatchObject({ error: `died on ${TOKEN}` });
    const cancelled: UnsequencedLogEvent = { type: "step-finished", ...env, status: "cancelled" };
    expect(maskedEvent(cancelled)).toEqual(cancelled);
  });

  it("masks an interpolated assignee on step-awaiting, and leaves a null assignee alone", () => {
    expect(maskedEvent(EVENTS["step-awaiting"])).toMatchObject({ assignee: TOKEN });
    const none: UnsequencedLogEvent = { type: "step-awaiting", ...env, assignee: null };
    expect(maskedEvent(none)).toEqual(none);
  });

  // mvp spec §8.1: a leaf's recorded value is "post-masking". A condition reads `context`/`output`,
  // and a step can publish an interpolated secret into either.
  it("masks the value recorded in a condition trace", () => {
    expect(maskedEvent(EVENTS["checkpoint-failed"])).toMatchObject({
      trace: { value: TOKEN, path: "context.k", outcome: "false" },
    });
  });

  it("masks trace values nested under all/any/not combinators", () => {
    const nested: Trace = {
      type: "all",
      outcome: "false",
      of: [
        {
          type: "not",
          outcome: "false",
          of: { type: "equals", path: "context.a", outcome: "true", value: "s3cret-value" },
        },
        {
          type: "any",
          outcome: "false",
          of: [{ type: "exists", path: "context.b", outcome: "false", message: "no s3cret-value" }],
        },
      ],
    };
    const masked = maskedEvent({ ...EVENTS["checkpoint-failed"], trace: nested });
    expect(JSON.stringify(masked)).not.toContain("s3cret-value");
    expect(JSON.stringify(masked)).toContain(TOKEN);
  });

  it("masks every trace of a branch-no-match, and the one a taken arm recorded", () => {
    expect(maskedEvent(EVENTS["branch-no-match"])).toMatchObject({ traces: [{ value: TOKEN }] });
    expect(maskedEvent(EVENTS["branch-taken"])).toMatchObject({ trace: { value: TOKEN } });
  });

  // The else arm has no condition, so it records no trace — masking must not build one.
  it("tolerates the null trace an else arm carries", () => {
    expect(maskedEvent({ ...EVENTS["branch-taken"], arm: "else", trace: null })).toMatchObject({
      arm: "else",
      trace: null,
    });
  });

  // The worker's own report, stored verbatim on the run row (§5.7) — the one payload the engine
  // neither built nor validated.
  it("masks the usage a worker reported, without disturbing its counts", () => {
    expect(maskedPayload(PAYLOADS.usage)).toEqual({
      kind: "usage",
      usage: { in: 1, note: TOKEN },
      estimatedCostUsd: 0.01,
    });
  });

  it("leaves a null usage null rather than masking it into something", () => {
    expect(maskedPayload({ ...PAYLOADS.usage, usage: null })).toMatchObject({ usage: null });
  });

  it("passes through, unchanged, the events that carry no maskable field", () => {
    for (const type of CANNOT_CARRY_A_SECRET)
      expect(maskedEvent(EVENTS[type])).toEqual(EVENTS[type]);
  });
});
