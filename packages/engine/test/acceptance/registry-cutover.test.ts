import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StepRequest, StepResult, WorkerDescriptor } from "../../src/plugin/seam.js";
import { runWorkflow } from "../../src/run-workflow.js";
import { fakeObserver } from "../fake-observer.js";

/**
 * The required acceptance test of the step-plugin exec cutover (#337, ADR 0021): a `@3` file carrying
 * **no `worker` key anywhere** runs a `binary` step and a `prompt` step end to end through the
 * *scanned* registry — the real `step-plugins/binary` and `step-plugins/prompt` folders, discovered by
 * the same scan a live run uses — with `prompt` overridden to a scripted worker. It covers the four
 * things the migration could break: the folder scan, the default-worker path for both built-in types,
 * `(type, worker-name)` dispatch, and the `workerOverrides` seam.
 */

// A scripted stand-in for `prompt`'s `sdk` worker: it records the request and answers a fixed string,
// so the run stays deterministic and free without the Agent SDK. It is plugged in as `prompt.sdk`.
function scriptedSdk(calls: StepRequest[]): WorkerDescriptor {
  return {
    meters: true,
    needsProcessorSlot: true,
    run: async (request: StepRequest): Promise<StepResult> => {
      calls.push(request);
      return { status: "succeeded", output: `SUMMARY of: ${String(request.input)}`, usage: { input_tokens: 5 }, estimatedCostUsd: 0.01 };
    },
  };
}

let fileDir: string;
beforeEach(() => {
  fileDir = mkdtempSync(join(tmpdir(), "path-registry-cutover-"));
});
afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

describe("acceptance: registry-driven load + dispatch (#337)", () => {
  it("runs a no-worker binary step and prompt step end to end through the scanned registry", async () => {
    const calls: StepRequest[] = [];
    const observer = fakeObserver();

    // No `worker` key on either leaf; `config.model` at the file top inherits to the prompt step.
    const file: WorkflowFile = {
      format: "path/workflow@3",
      id: "00000000-0000-4000-8000-000000000000",
      name: "cutover",
      config: { model: "test-model" },
      body: [
        {
          type: "binary",
          id: "11111111-1111-4111-8111-111111111111",
          name: "gather",
          command: process.execPath,
          args: ["-e", "process.stdout.write('CHANGES')"],
        },
        {
          type: "prompt",
          id: "22222222-2222-4222-8222-222222222222",
          name: "summarize",
          prompt: "Summarize the input.",
          publish: { summary: "${output}" },
        },
      ],
      output: { notes: "${context.summary}" },
    };

    const result = await runWorkflow(file, fileDir, {
      observer,
      workerOverrides: { prompt: { sdk: scriptedSdk(calls) } },
    });

    // End to end: the binary ran on the real `spawn` worker and its output threaded into the prompt,
    // which ran on the overridden `sdk` worker; the workflow output is the prompt's result.
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ notes: "SUMMARY of: CHANGES" });

    // The prompt's default worker (`sdk`) received the binary's output as its input.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("CHANGES");

    // Each leaf dispatched to its type's default worker — one `(type, worker-name)` lookup, no worker
    // key in the file. The audit records the resolved worker name for each.
    const started = observer["step-started"].mock.calls.map((c) => c[0]);
    const gather = started.find((s) => s.nodeName === "gather")!;
    const summarize = started.find((s) => s.nodeName === "summarize")!;
    expect(gather.workerName).toBe("spawn");
    expect(gather.stepType).toBe("binary");
    expect(summarize.workerName).toBe("sdk");
    expect(summarize.stepType).toBe("prompt");

    // Only the metering worker's spend is recorded: `sdk` meters, `spawn` does not.
    const usage = observer["step-usage"].mock.calls.map((c) => c[0]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usage: { input_tokens: 5 }, estimatedCostUsd: 0.01 });
  });
});
