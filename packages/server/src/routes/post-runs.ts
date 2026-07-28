import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { loadWorkflowTree, LOG_BACKEND_IDS, type Project } from "@path/engine";
import { ConfigObjectSchema, formatIssues, type JsonValue } from "@path/schema";
import { z } from "zod";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import type { LiveRuns } from "../live-runs.js";

const PostRunsBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    input: z.record(z.unknown()).optional(),
    config: ConfigObjectSchema.optional(),
    log_backends: z.array(z.enum(LOG_BACKEND_IDS)).optional(),
    llm_concurrency: z.number().int().positive().optional(),
  })
  .strict();

/**
 * `workflow_path` resolves against the server's fixed project root, the same way `path run
 * <workflow.json>` resolves against the cwd (server-api-v0.md §2) — except a path that escapes
 * the project root is rejected rather than followed, since the server (unlike the CLI) isn't
 * trusted with the operator's whole filesystem.
 */
function resolveWorkflowPath(projectDir: string, workflowPath: string): string | undefined {
  const absPath = resolve(projectDir, workflowPath);
  const rel = relative(projectDir, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return absPath;
}

export interface RunsRouteContext {
  /**
   * The opened project (#64): its `.path/`, its engine settings, what its runs left behind
   * (`project.archive`), and the one way to run a workflow against it.
   */
  project: Project;
  /** The runs this process is executing: starting, cancelling, and watching them. */
  live: LiveRuns;
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
  const { workflow_path: workflowPath, input, config, log_backends: logBackendIds, llm_concurrency: llmConcurrency } =
    parsed.data;

  const absPath = resolveWorkflowPath(ctx.project.dir, workflowPath);
  if (!absPath) {
    sendError(res, 404, `workflow_path "${workflowPath}" resolves outside the project root`);
    return;
  }
  if (!existsSync(absPath)) {
    sendError(res, 404, `workflow file not found: "${workflowPath}"`);
    return;
  }

  const loadResult = loadWorkflowTree(absPath);
  if (!loadResult.success) {
    sendError(res, 400, "workflow validation failed", loadResult.errors);
    return;
  }
  const { tree } = loadResult;
  const rootFile = tree.files.get(tree.rootPath);
  if (!rootFile) {
    sendError(res, 500, "internal error: root file missing from loaded tree");
    return;
  }

  let ids;
  try {
    // The *root workflow file's own* directory — what the engine resolves nested `workflow` refs and
    // binary `cwd`s against. Distinct from the project directory, which is where `.path/` lives;
    // passing the latter here is what broke nested refs in #59.
    ids = await ctx.live.start(rootFile, dirname(tree.rootPath), {
      input: input as { [key: string]: JsonValue } | undefined,
      operatorConfig: config,
      files: tree.files,
      logBackends: logBackendIds,
      llmConcurrency,
    });
  } catch (err) {
    sendError(res, 500, `run failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  sendJson(res, 202, { run_id: ids.runId, root_run_id: ids.rootRunId });
}
