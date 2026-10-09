import { describe, expect, it } from "vitest";
import type { ProjectResumeOptions } from "../src/project.js";
import { runHistory } from "../src/run-history.js";
import type { RunOptions } from "../src/run-options.js";
import type { ContinuationInput } from "../src/run-workflow.js";

/**
 * The entry options as two arms. A launch is the only arm that can carry the operator's override
 * input (ADR 0046): a continuation restores the Context blackboard, so an input has no effect and
 * no home. These assertions are compile-time — `@ts-expect-error` fails the build if the error
 * ever stops happening.
 */

const continuation: ContinuationInput = {
  kind: "resume",
  history: runHistory([], () => null),
};

describe("RunOptions arms", () => {
  it("refuses an operator input on a continuation", () => {
    // @ts-expect-error a continuation never re-applies an input, so the launch arm is its only home
    const options: RunOptions = { continuation, operatorInput: { topic: "release" } };

    expect(options.continuation?.kind).toBe("resume");
  });

  it("keeps a continuation's own facts, and the launch-only ones off a launch", () => {
    const resumed: RunOptions = {
      continuation,
      unresolvedLaunchSecrets: ["token"],
      launchWorkerDefaults: { prompt: "deepseek" },
    };
    // @ts-expect-error missing launch secrets are a continuation's fact, not a launch's
    const launched: RunOptions = { unresolvedLaunchSecrets: ["token"] };

    expect(resumed.continuation?.kind).toBe("resume");
    expect(launched.operatorInput).toBeUndefined();
  });

  it("refuses an operator input at the Project's resume door too", () => {
    // @ts-expect-error `Project.resume` takes the continuation arm, which has no operator input
    const options: ProjectResumeOptions = { operatorInput: { topic: "release" } };

    expect(options.rerunFromRunId).toBeUndefined();
  });
});
