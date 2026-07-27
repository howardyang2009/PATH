import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

  // Resolved as soon as the first `run-started` observation arrives — the async contract (§2): the
  // response goes out before the run finishes, not before it starts.
  const started = createDeferred<{ runId: string; rootRunId: string }>();
  // The handle `POST /v0/runs/:root_run_id/cancel` (§4.2) aborts. It can only be filed under an id
  // that exists, which is why registration waits for `run-started` rather than happening here.
  const controller = new AbortController();
  let registeredRootRunId: string | undefined;
  const captureObserver: RunObserver = {
    observe(o) {
      if (o.type !== "run-started") return;
      // Fires for every run in the tree, all sharing one `rootRunId` — register on the first only.
      if (registeredRootRunId === undefined) {
        registeredRootRunId = o.rootRunId;
        ctx.controllers.register(o.rootRunId, controller);
      }
      started.resolve({ runId: o.runId, rootRunId: o.rootRunId });
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

  // Two different directories meet here, and only one of them is `projectDir`. `projectDir` is where
  // `.path/` is read and written, which is why the observer and the log backends above take it. What
  // `runWorkflow` wants second is the *root workflow file's own* directory: it resolves nested
  // `workflow` refs and binary `cwd`s against it. The CLI never had to tell them apart, because it
  // derives its project dir from the workflow file (`cli.ts:258`) — so the two are always equal
  // there. For the server they diverge for any workflow that is not at the project root, and passing
  // `projectDir` here meant a nested ref resolved beside `.path/` instead of beside the file that
  // wrote it, so it was never in the loaded tree (#59).
  const workflowDir = dirname(tree.rootPath);

  const runPromise = runWorkflow(rootFile, workflowDir, {
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
  // also settles `started` (a no-op if the response already went out).
  runPromise
    .then(
      (result) => {
        if (result.status === "failed") console.error(`run failed: ${result.error}`);
      },
      (err) => {
        started.reject(err);
        console.error(`run crashed: ${err instanceof Error ? err.stack : String(err)}`);
      },
    )
    // However it ended, the run is over: dropping the controller here rather than in each arm is
    // what makes "on every outcome" true by construction, so a long-lived server accumulates none.
    .finally(() => {
      if (registeredRootRunId !== undefined) ctx.controllers.delete(registeredRootRunId);
    });

  let ids: { runId: string; rootRunId: string };
  try {
    ids = await started.promise;
  } catch (err) {
    sendError(res, 500, `run failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  sendJson(res, 202, { run_id: ids.runId, root_run_id: ids.rootRunId });
}
