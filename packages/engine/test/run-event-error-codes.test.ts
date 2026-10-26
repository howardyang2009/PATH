import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/run-workflow.js";
import { fakeObserver } from "./fake-observer.js";
import { stampNames } from "./stamp-names.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function workflow(body: unknown[], config?: WorkflowFile["config"]): WorkflowFile {
  return stampNames({
    format: "path/workflow@6",
    id: "wf-id",
    name: "coded",
    ...(config ? { config } : {}),
    body: body as WorkflowFile["body"],
  });
}

async function failedFinishes(file: WorkflowFile) {
  const observer = fakeObserver();
  await runWorkflow(file, fixturesDir, { observer });
  return observer
    .stepFinishes()
    .concat(observer.runFinishes())
    .map((e) => e.event)
    .filter((e) => e?.type === "step-finished" && e.status === "failed");
}

describe("step-finished error codes (ADR 0107 point 4)", () => {
  it("wraps a worker's error verbatim under the step label code", async () => {
    const [step, root] = await failedFinishes(
      workflow([
        {
          type: "binary",
          id: "boom",
          name: "boom",
          command: "node",
          args: ["-e", "process.stderr.write('disk on fire'); process.exit(2)"],
        },
      ]),
    );
    expect(step).toMatchObject({
      error: expect.stringMatching(/^step "boom": .*exited with code 2.*disk on fire/s),
      error_code: "step.failed",
      error_params: {
        name: "boom",
        error: { key: "shared.verbatim", params: { text: expect.stringMatching(/disk on fire/) } },
      },
    });
    expect(root).toMatchObject({ error: step?.error, error_code: "step.failed" });
  });

  it("codes an engine failure with its own params", async () => {
    const [root] = await failedFinishes(
      workflow([
        {
          type: "checkpoint",
          id: "gate",
          name: "gate",
          condition: { type: "exists", path: "context.ready" },
        },
      ]),
    );
    expect(root).toMatchObject({
      error: 'checkpoint "gate" failed: path "context.ready" does not resolve',
      error_code: "checkpoint.failed",
      error_params: {
        name: "gate",
        reason: { key: "errors.condition.unresolved", params: { path: "context.ready" } },
      },
    });
  });

  it("codes a run-start failure with a plural count", async () => {
    const [root] = await failedFinishes(
      workflow([{ type: "binary", id: "s", name: "s", command: "node", args: ["-e", ""] }], {
        a: { $env: "PATH_TEST_UNSET_A" },
        b: { $env: "PATH_TEST_UNSET_B" },
      }),
    );
    expect(root).toMatchObject({
      error:
        'run failed before its first step: 2 environment variables are not set: "PATH_TEST_UNSET_A" (config key "a"), "PATH_TEST_UNSET_B" (config key "b")',
      error_code: "run-start.env-unset",
      error_params: { count: 2 },
    });
  });
});
