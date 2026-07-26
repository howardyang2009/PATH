import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import {
  composeObservers,
  createLoggingObserver,
  createLogBackends,
  createPersistedObserver,
  DEFAULT_LOG_BACKENDS,
  loadWorkflowTree,
  LOG_BACKEND_IDS,
  runWorkflow,
  type RunObserver,
} from "@path/engine";
import { ConfigObjectSchema, formatIssues, type JsonValue } from "@path/schema";
import type Database from "better-sqlite3";
import { z } from "zod";
import { createDeferred } from "../deferred.js";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import { createLiveLogBackend } from "../live-log-backend.js";
import type { RunControllers } from "../run-controllers.js";
import type { RunEventHub } from "../run-event-hub.js";

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
  projectDir: string;
  db: Database.Database;
  hub: RunEventHub;
  controllers: RunControllers;
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

  const absPath = resolveWorkflowPath(ctx.projectDir, workflowPath);
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

  const backends = createLogBackends(logBackendIds ?? DEFAULT_LOG_BACKENDS, {
    db: ctx.db,
    projectDir: ctx.projectDir,
  });

  // Resolved as soon as `runWorkflow`'s `runStarted` hook fires — the async contract (§2): the
  // response goes out before the run finishes, not before it starts.
  const started = createDeferred<{ runId: string; rootRunId: string }>();
  // The handle `POST /v0/runs/:root_run_id/cancel` (§4.2) aborts. It can only be filed under an id
  // that exists, which is why registration waits for `runStarted` rather than happening here.
  const controller = new AbortController();
  let registeredRootRunId: string | undefined;
  const captureObserver: RunObserver = {
    runStarted(info) {
      // Fires for every run in the tree, all sharing one `rootRunId` — register on the first only.
      if (registeredRootRunId === undefined) {
        registeredRootRunId = info.rootRunId;
        ctx.controllers.register(info.rootRunId, controller);
      }
      started.resolve({ runId: info.runId, rootRunId: info.rootRunId });
    },
  };
  // The live-forwarding backend rides alongside the configured db/NDJSON backends so SSE clients
  // (§5) see every already-masked event in `seq` order — independent of which log_backends the
  // client persisted to. It never throws, so it can't fail the run.
  const observer = composeObservers(
    createPersistedObserver(ctx.db, ctx.projectDir),
    createLoggingObserver([...backends, createLiveLogBackend(ctx.hub)]),
    captureObserver,
  );

  const runPromise = runWorkflow(rootFile, ctx.projectDir, {
    input: input as { [key: string]: JsonValue } | undefined,
    operatorConfig: config,
    files: tree.files,
    observer,
    llmConcurrency,
    signal: controller.signal,
    warn: (message) => console.error(`warning: ${message}`),
  });
  // Fire-and-forget from the request's point of view: the run keeps executing after the response
  // goes out. Never left unhandled — a rejection here means `runStarted` never fired either, so it
  // also settles `started` (a no-op if the response already went out). Either way the run is over,
  // so its controller is dropped on every outcome — a long-lived server accumulates none.
  runPromise.then(
    (result) => {
      if (registeredRootRunId !== undefined) ctx.controllers.delete(registeredRootRunId);
      if (result.status === "failed") console.error(`run failed: ${result.error}`);
    },
    (err) => {
      if (registeredRootRunId !== undefined) ctx.controllers.delete(registeredRootRunId);
      started.reject(err);
      console.error(`run crashed: ${err instanceof Error ? err.stack : String(err)}`);
    },
  );

  let ids: { runId: string; rootRunId: string };
  try {
    ids = await started.promise;
  } catch (err) {
    sendError(res, 500, `run failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  sendJson(res, 202, { run_id: ids.runId, root_run_id: ids.rootRunId });
}
