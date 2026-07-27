import { describe, expect, it } from "vitest";
import type { Trace } from "../src/condition.js";
import type { Observation } from "../src/run-observer.js";
import { collectSecrets, maskObservation } from "../src/secret-mask.js";

const masker = collectSecrets([{ token: { $secret: "s3cret-value" } }]);
const TOKEN = "[secret:token]";

const ids = { runId: "r1", rootRunId: "r0" };
const worker = { type: "engine" } as const;

/** Every observation type, so a member added without a masking decision fails to compile here. */
const SAMPLES: { [K in Observation["type"]]: Extract<Observation, { type: K }> } = {
  "run-started": { type: "run-started", ...ids, parentRunId: null, nodeId: null, input: { k: "s3cret-value" }, worker },
  "step-started": {
    type: "step-started",
    ...ids,
    parentRunId: "r0",
    nodeId: "n1",
    stepType: "binary",
    worker,
    input: { k: "s3cret-value" },
  },
  "step-stderr": { type: "step-stderr", ...ids, stderr: "boom s3cret-value" },
  "step-usage": { type: "step-usage", ...ids, usage: { in: 1 }, estimatedCostUsd: 0.01 },
  "step-finished": { type: "step-finished", ...ids, status: "succeeded", output: { k: "s3cret-value" } },
  "context-changed": { type: "context-changed", ...ids, context: { k: "s3cret-value" } },
  "join-applied": { type: "join-applied", ...ids, nodeId: "n1", branches: ["a"], publishedKeys: ["k"] },
  "run-cancelled": { type: "run-cancelled", ...ids, nodeId: "n1", cause: "operator", causeRunId: null },
  "run-finished": { type: "run-finished", ...ids, status: "succeeded", output: { k: "s3cret-value" } },
  "checkpoint-evaluated": {
    type: "checkpoint-evaluated",
    ...ids,
    nodeId: "n1",
    passed: false,
    trace: { type: "equals", path: "context.k", outcome: "false", value: "s3cret-value" },
  },
  "branch-taken": { type: "branch-taken", ...ids, nodeId: "n1", arm: 0, trace: null },
  "branch-no-match": {
    type: "branch-no-match",
    ...ids,
    nodeId: "n1",
    traces: [{ type: "equals", path: "context.k", outcome: "false", value: "s3cret-value" }],
  },
  "iteration-started": {
    type: "iteration-started",
    ...ids,
    nodeId: "n1",
    iteration: 1,
    trace: { type: "exists", path: "context.k", outcome: "true", value: "s3cret-value" },
  },
  "loop-exited": {
    type: "loop-exited",
    ...ids,
    nodeId: "n1",
    reason: "condition-false",
    iterations: 2,
    trace: { type: "exists", path: "context.k", outcome: "false", value: "s3cret-value" },
  },
};

describe("maskObservation", () => {
  it("leaves no secret in any observation type", () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(JSON.stringify(maskObservation(masker, sample))).not.toContain("s3cret-value");
    }
  });

  it("preserves the type of every observation", () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(maskObservation(masker, sample).type).toBe(sample.type);
    }
  });

  it("masks input on run-started and step-started", () => {
    expect(maskObservation(masker, SAMPLES["run-started"])).toMatchObject({ input: { k: TOKEN } });
    expect(maskObservation(masker, SAMPLES["step-started"])).toMatchObject({ input: { k: TOKEN } });
  });

  it("masks stderr and context", () => {
    expect(maskObservation(masker, SAMPLES["step-stderr"])).toMatchObject({ stderr: `boom ${TOKEN}` });
    expect(maskObservation(masker, SAMPLES["context-changed"])).toMatchObject({ context: { k: TOKEN } });
  });

  it("masks a succeeded output and a failed error, and leaves a cancelled outcome alone", () => {
    expect(maskObservation(masker, SAMPLES["step-finished"])).toMatchObject({ output: { k: TOKEN } });

    const failed: Observation = { type: "run-finished", ...ids, status: "failed", error: "died on s3cret-value" };
    expect(maskObservation(masker, failed)).toMatchObject({ error: `died on ${TOKEN}` });

    const cancelled: Observation = { type: "step-finished", ...ids, status: "cancelled" };
    expect(maskObservation(masker, cancelled)).toEqual(cancelled);
  });

  // mvp spec §8.1: a leaf's recorded value is "post-masking". A condition reads `context`/`output`,
  // and a step can publish an interpolated secret into either.
  it("masks the value recorded in a condition trace", () => {
    const masked = maskObservation(masker, SAMPLES["checkpoint-evaluated"]);
    expect(masked).toMatchObject({ trace: { value: TOKEN, path: "context.k", outcome: "false" } });
  });

  it("masks trace values nested under all/any/not combinators", () => {
    const nested: Trace = {
      type: "all",
      outcome: "false",
      of: [
        { type: "not", outcome: "false", of: { type: "equals", path: "context.a", outcome: "true", value: "s3cret-value" } },
        { type: "any", outcome: "false", of: [{ type: "exists", path: "context.b", outcome: "false", message: "no s3cret-value" }] },
      ],
    };
    const masked = maskObservation(masker, { ...SAMPLES["checkpoint-evaluated"], trace: nested });
    expect(JSON.stringify(masked)).not.toContain("s3cret-value");
    expect(JSON.stringify(masked)).toContain(TOKEN);
  });

  it("masks every trace of a branch-no-match, and tolerates a null branch-taken trace", () => {
    expect(maskObservation(masker, SAMPLES["branch-no-match"])).toMatchObject({ traces: [{ value: TOKEN }] });
    expect(maskObservation(masker, SAMPLES["branch-taken"])).toMatchObject({ trace: null });
  });

  it("passes through observations that carry no maskable payload", () => {
    for (const type of ["step-usage", "join-applied", "run-cancelled"] as const) {
      expect(maskObservation(masker, SAMPLES[type])).toEqual(SAMPLES[type]);
    }
  });
});
