import type { IncomingMessage, ServerResponse } from "node:http";
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
import type { RouteContext } from "./route-context.js";

const PostRunsBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    input: z.record(z.string(), z.unknown()).optional(),
    config: ConfigObjectSchema.optional(),
    // The launch worker-default table (ADR 0044, #517): a top-level `{ <type>: <name> }` peer of
    // `input`/`config`, not folded into `config` (dispatch never reads `config` for worker selection).
    // Non-empty keys and values, mirroring the file channel's `worker_defaults` grammar
    // (`@path/schema` workflow-file.ts). This is the *shape* net only; registry-relative validity (an
    // absent type or an unshipped worker) is the launch-boundary check below (#518), run once the
    // workflow's registry is in hand — a bad table `400`s before the run starts.
    worker_defaults: z.record(z.string().min(1), z.string().min(1)).optional(),
    log_backends: z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    processor_concurrency: z.number().int().positive().optional(),
  })
  .strict();

export async function handlePostRuns(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
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

  // ADR 0012 / #231: operator config may carry a literal `{"$secret": "..."}` but not `{"$env":
  // "NAME"}`. Rejected before the filesystem is touched, as a bad config invalidates the request
  // whatever the workflow turns out to be. `resume-run.ts` makes the same call — one spelling of the
  // rule (launch.ts), not two.
  if (config !== undefined) {
    const envError = operatorConfigEnvError(config);
    if (envError) {
      sendError(res, 400, envError);
      return;
    }
  }

  // Escape / not-found / invalid, decided once for both launch surfaces (launch.ts). A fresh launch
  // distinguishes an escaping `workflow_path` from a merely missing one — both 404, both naming the
  // path the caller sent.
  const prepared = await prepareWorkflow(ctx.project.dir, workflowPath, {
    notFound: (p) => `workflow file not found: "${p}"`,
    escapesRoot: (p) => `workflow_path "${p}" resolves outside the project root`,
  });
  if (!prepared.ok) {
    sendError(res, prepared.refusal.status, prepared.refusal.message, prepared.refusal.details);
    return;
  }
  const { workflow } = prepared;

  // The launch channel of ADR 0044's registry-relative validation (#518). The launch `worker_defaults`
  // is operator input, authored in no file and seen by no Designer, so a bad entry — an absent type, or
  // a worker a type does not ship — is a bad request: `400` before the run starts, checked against the
  // run's one registry (the one the load validated the file against). Every bad entry is reported in one
  // pass, prefixed `worker_defaults:` so the operator knows which field to fix — the same taxonomy the
  // CLI `--worker-default` boundary uses.
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
    // `workflow.workflowDir` is the *root workflow file's own* directory — what the engine resolves
    // nested `workflow` refs and binary `cwd`s against. Distinct from the project directory, which is
    // where `.path/` lives; passing the latter here is what broke nested refs in #59.
    ids = await ctx.live.start(workflow.rootFile, workflow.workflowDir, {
      // The effective root input and the recorded override, by the one rule every launch door shares
      // (format @4 §1a, ADR 0046): the run records the input it actually seeded, not the file default.
      ...launchInput(input as { [key: string]: JsonValue } | undefined, workflow.rootFile.input),
      operatorConfig: config,
      // The operator's run-wide launch worker-default table (ADR 0044, #517), forwarded verbatim to the
      // engine's `RunOptions.launchWorkerDefaults` so an HTTP launch resolves un-pinned steps exactly as
      // an equivalent `path run --worker-default` launch. Undefined when the field was omitted, so a
      // request without it resolves through the file/default tiers unchanged.
      launchWorkerDefaults,
      files: workflow.files,
      // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
      registry: workflow.registry,
      logBackends: logBackendIds,
      processorConcurrency,
      // Recorded on the root row so this run is resumable (§4.3), the same relative form `path run`
      // stores — the normalized path, not the raw request string.
      sourceWorkflowPath: workflow.storeRelativePath(ctx.project.dir),
    });
  } catch (err) {
    sendError(res, 500, `run failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const started: StartRunResponse = { run_id: ids.runId, root_run_id: ids.rootRunId };
  sendJson(res, 202, started);
}
