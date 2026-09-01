import type { IncomingMessage, ServerResponse } from "node:http";
import { LOG_BACKEND_IDS, type LoadedStepPluginRegistry, type Project } from "@path/engine";
import { ConfigObjectSchema, formatIssues, type JsonValue, type StartRunResponse } from "@path/schema";
import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import { operatorConfigEnvError, prepareWorkflow } from "../launch.js";
import type { LiveRuns } from "../live-runs.js";

const PostRunsBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    input: z.record(z.unknown()).optional(),
    config: ConfigObjectSchema.optional(),
    log_backends: z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    processor_concurrency: z.number().int().positive().optional(),
  })
  .strict();

export interface RunsRouteContext {
  /**
   * The opened project (#64): its `.path/`, its engine settings, what its runs left behind
   * (`project.archive`), and the one way to run a workflow against it.
   */
  project: Project;
  /** The runs this process is executing: starting, cancelling, and watching them. */
  live: LiveRuns;
  /**
   * The step-plugin registry frozen at server start, served by `GET /v0/step-plugins` as the Designer's
   * authoring palette (server-api-v0.md §8, ADR 0018). A bare snapshot with no staleness contract:
   * scanned once, never per request, so the palette is fixed for the server's life.
   */
  stepPlugins: LoadedStepPluginRegistry;
}

export async function handlePostRuns(req: IncomingMessage, res: ServerResponse, ctx: RunsRouteContext): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return;
  }

  const parsed = PostRunsBodySchema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return;
  }
  const { workflow_path: workflowPath, input, config, log_backends: logBackendIds, processor_concurrency: processorConcurrency } =
    parsed.data;

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

  let ids;
  try {
    // `workflow.workflowDir` is the *root workflow file's own* directory — what the engine resolves
    // nested `workflow` refs and binary `cwd`s against. Distinct from the project directory, which is
    // where `.path/` lives; passing the latter here is what broke nested refs in #59.
    ids = await ctx.live.start(workflow.rootFile, workflow.workflowDir, {
      input: input as { [key: string]: JsonValue } | undefined,
      operatorConfig: config,
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
