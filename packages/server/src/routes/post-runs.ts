import { LOG_BACKEND_IDS } from "@path/engine";
import {
  ConfigObjectSchema,
  type JsonValue,
  launchInput,
  type StartRunResponse,
  validateLaunchWorkerDefaults,
} from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareWorkflow } from "../launch.js";
import type { StartedRun } from "../live-runs.js";
import type { ApiRequest } from "./route-context.js";

const PostRunsBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    config: ConfigObjectSchema.optional(),
    // The launch worker-default table (ADR 0044): a top-level peer of `input`/`config`. Shape-only here;
    // registry-relative validity is the launch-boundary check below.
    worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    log_backends: z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    processor_concurrency: z.number().int().positive().optional(),
  })
  .strict();

export async function handlePostRuns({ req, res, ctx }: ApiRequest): Promise<void> {
  const body = await readRequestBody(req, res, PostRunsBodySchema);
  if (!body) return;
  const {
    workflow_path: workflowPath,
    input,
    config,
    worker_defaults: launchWorkerDefaults,
    log_backends: logBackendIds,
    processor_concurrency: processorConcurrency,
  } = body.data;

  // ADR 0012: operator config may carry a literal `$secret` but not `$env`. Rejected before the
  // filesystem is touched — a bad config invalidates the request whatever the workflow turns out to be.
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) {
      sendError(res, 400, envError);
      return;
    }
  }

  // Escape / not-found / invalid, decided once for both launch surfaces (launch.ts).
  const prepared = await prepareWorkflow(ctx.project.dir, workflowPath, {
    notFound: (p) => `workflow file not found: "${p}"`,
    escapesRoot: (p) => `workflow_path "${p}" resolves outside the project root`,
  });
  if (!prepared.ok) {
    sendError(res, prepared.refusal.status, prepared.refusal.message, prepared.refusal.details);
    return;
  }
  const { workflow } = prepared;

  // The launch channel of ADR 0044's registry-relative validation: `worker_defaults` is operator input,
  // authored in no file, so a bad entry is a `400` before the run starts, every bad entry in one pass.
  const workerDefaultErrors = validateLaunchWorkerDefaults(
    launchWorkerDefaults,
    workflow.registry,
  ).map((message) => `worker_defaults: ${message}`);
  if (workerDefaultErrors.length > 0) {
    sendError(res, 400, "invalid worker_defaults", workerDefaultErrors);
    return;
  }

  let ids: StartedRun;
  try {
    // The *root workflow file's own* directory — what the engine resolves nested `workflow` refs and
    // binary `cwd`s against. Distinct from the project directory, where `.path/` lives.
    ids = await ctx.live.start(workflow.rootFile, workflow.workflowDir, {
      // The effective root input and recorded override, by the one rule every launch door shares
      // (format @4 §1a, ADR 0046): the run records the input it actually seeded, not the file default.
      ...launchInput(input as { [key: string]: JsonValue } | undefined, workflow.rootFile.input),
      operatorConfig: config,
      // Forwarded verbatim to the engine's `RunOptions.launchWorkerDefaults` (ADR 0044).
      launchWorkerDefaults,
      files: workflow.files,
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
      registry: workflow.registry,
      logBackends: logBackendIds,
      processorConcurrency,
      // Recorded on the root row so this run is resumable (§4.3), in the same relative form `path run` stores.
      sourceWorkflowPath: workflow.storeRelativePath(ctx.project.dir),
    });
  } catch (err) {
    sendError(res, 500, `run failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const started: StartRunResponse = { run_id: ids.runId, root_run_id: ids.rootRunId };
  sendJson(res, 202, started);
}
