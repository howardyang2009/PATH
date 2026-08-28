// A fixture step-type plugin that compiles against the public `@path/engine/plugin` contract exactly
// as a third-party plugin does (#333 acceptance). It is a *typecheck* fixture: it lives under `test/`,
// not `packages/engine/step-plugins/`, so the engine's plugin scan never registers it. Its only job is
// to prove the seam is expressive enough — two `fields`/`config` fragments, and a worker whose `run`
// sees `fields`/`config` inferred from this plugin's own zod fragments (acceptance #3, #4).

import { defineStepPlugin, resolveAgainstWorkflowDir, z } from "@path/engine/plugin";

export const stepPlugin = defineStepPlugin({
  // Author-fixed on the node: what the call *is* (ADR 0022 — a field is operator-invariant).
  fields: {
    endpoint: z.string(),
    method: z.enum(["GET", "POST"]),
  },
  // Injected from outside: inheritable, operator-overridable, `$env`/`$secret`-capable. `token` is
  // required (a non-optional key), `retries` is not (ADR 0022 sub-5).
  config: {
    token: z.string(),
    retries: z.number().optional(),
  },
  workers: {
    fetch: {
      needsProcessorSlot: false,
      meters: false,
      run: async (request) => {
        // `fields` is inferred from the `fields` fragment above: `endpoint` is a `string`, `method` a
        // `"GET" | "POST"`. A wrong key or a wrong type here is a compile error — that is acceptance #4.
        const endpoint: string = request.fields.endpoint;
        const method: "GET" | "POST" = request.fields.method;
        // `config` is inferred from the `config` fragment: `token` is a `string`, `retries` optional.
        const token: string = request.config.token;
        const retries: number | undefined = request.config.retries;
        // The anchor helper resolves a relative path against the workflow dir the engine passed in.
        const where = resolveAgainstWorkflowDir(request.cwd, "./out");

        if (request.signal.aborted) {
          return { status: "failed", error: "aborted before start" };
        }

        return {
          status: "succeeded",
          output: { endpoint, method, token, retries: retries ?? 0, input: request.input, where },
          usage: null,
          estimatedCostUsd: 0,
          stderr: "",
        };
      },
    },
  },
  defaultWorker: "fetch",
});
