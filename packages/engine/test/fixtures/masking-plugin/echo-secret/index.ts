import { defineStepPlugin, z } from "@path/engine/plugin";
import type { StepRequest, StepResult } from "@path/engine/plugin";

/**
 * A fixture step-type plugin for the plugin-masking acceptance test (ADR 0020 sub-decision 10, #338).
 * It is NOT shipped — it lives under `test/fixtures/` and is reached only by a run that points its
 * scan at this directory (`RunOptions.stepPluginsDir`). Its whole job is to be a plugin the engine
 * never special-cased: a third-party-shaped folder whose worker takes a real `$secret` off its
 * resolved config and hands it straight back through *every* channel a `StepResult` carries — `output`,
 * `stderr`, and `usage` — so the test can prove each reaches disk only as a masked observation.
 *
 * The folder name `echo-secret` *is* the type name (ADR 0019 sub-1), so this file states none.
 */

// No author-fixed node fields — the step does one thing and reads its secret from config.
const fields = {};

// The one injected config key: the run supplies `{"$secret": "<value>"}` here, and the engine resolves
// it to the real value before the worker runs (ADR 0022 sub-3, mvp spec §8.3 — workers get real values).
const config = { secret: z.string() };

/**
 * Return the secret verbatim in all three result channels. The worker never thinks about masking:
 * that is the point — masking is inherited by construction at the engine's emit choke point (ADR 0020
 * sub-1), so an author who does nothing still leaks nothing to disk.
 */
function runEcho(request: StepRequest<typeof fields, typeof config>): Promise<StepResult> {
  const { secret } = request.config;
  return Promise.resolve({
    status: "succeeded",
    output: { echoed: secret },
    stderr: `worker handled the value ${secret}`,
    usage: { note: `spent on ${secret}`, tokens: 1 },
    estimatedCostUsd: 0.01,
  });
}

export const stepPlugin = defineStepPlugin({
  fields,
  config,
  // `meters: true` so the engine emits the `step-usage` observation whose `usage` this test checks.
  workers: {
    echo: { meters: true, needsProcessorSlot: false, run: runEcho },
  },
  defaultWorker: "echo",
});
