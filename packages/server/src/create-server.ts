import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject } from "@path/engine";
import { sendError } from "./http-json.js";
import { handleCancelRun } from "./routes/cancel-run.js";
import { handleResumeRun } from "./routes/resume-run.js";
import { handleGetRun } from "./routes/get-run.js";
import { handleGetRunBlob } from "./routes/get-run-blob.js";
import { handleGetRunEvents } from "./routes/get-run-events.js";
import { handleListRuns } from "./routes/list-runs.js";
import { handleGetWorkflows } from "./routes/get-workflows.js";
import { createLiveRuns } from "./live-runs.js";
import { enforceSameOrigin } from "./origin-gate.js";
import { handlePostRuns, type RunsRouteContext } from "./routes/post-runs.js";
import { serveStatic } from "./serve-static.js";

const RUN_ID_ROUTE = /^\/v0\/runs\/([^/]+)$/;
const RUN_EVENTS_ROUTE = /^\/v0\/runs\/([^/]+)\/events$/;
const RUN_CANCEL_ROUTE = /^\/v0\/runs\/([^/]+)\/cancel$/;
const RUN_RESUME_ROUTE = /^\/v0\/runs\/([^/]+)\/resume$/;
const RUN_BLOB_ROUTE = /^\/v0\/runs\/([^/]+)\/blobs\/([^/]+)\/([^/]+)$/;

/**
 * Where `path-server` looks for the built `@path/viewer` bundle when no `staticDir` is passed:
 * `packages/viewer/dist`, resolved relative to this package. Absent until the viewer is built —
 * `serveStatic` no-ops (falls through to a 404) when the directory or its `index.html` is missing.
 */
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../viewer/dist", import.meta.url));

/** True for the `/v0/*` API namespace, whose unmatched routes keep their JSON 404s (never SPA HTML). */
function isApiPath(pathname: string): boolean {
  return pathname === "/v0" || pathname.startsWith("/v0/");
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  staticDir: string,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    // Every state-changing route is a non-GET method. Gate them all against cross-origin browser
    // CSRF here (#237, origin-gate.ts) rather than per-route, so a future mutating route can't ship
    // ungated by forgetting a hand-placed check. GET/HEAD are safe reads and pass through.
    if (req.method !== "GET" && req.method !== "HEAD" && !enforceSameOrigin(req, res)) return;

    if (req.method === "POST" && pathname === "/v0/runs") {
      await handlePostRuns(req, res, ctx);
      return;
    }

    if (req.method === "GET" && pathname === "/v0/runs") {
      handleListRuns(res, ctx, url.searchParams);
      return;
    }

    if (req.method === "GET" && pathname === "/v0/workflows") {
      handleGetWorkflows(res, ctx);
      return;
    }

    const cancelMatch = RUN_CANCEL_ROUTE.exec(pathname);
    if (req.method === "POST" && cancelMatch) {
      handleCancelRun(res, ctx, decodeURIComponent(cancelMatch[1]!));
      return;
    }

    const resumeMatch = RUN_RESUME_ROUTE.exec(pathname);
    if (req.method === "POST" && resumeMatch) {
      await handleResumeRun(req, res, ctx, decodeURIComponent(resumeMatch[1]!));
      return;
    }

    const eventsMatch = RUN_EVENTS_ROUTE.exec(pathname);
    if (req.method === "GET" && eventsMatch) {
      handleGetRunEvents(req, res, ctx, decodeURIComponent(eventsMatch[1]!));
      return;
    }

    const blobMatch = RUN_BLOB_ROUTE.exec(pathname);
    if (req.method === "GET" && blobMatch) {
      handleGetRunBlob(
        res,
        ctx,
        decodeURIComponent(blobMatch[1]!),
        decodeURIComponent(blobMatch[2]!),
        decodeURIComponent(blobMatch[3]!),
      );
      return;
    }

    const match = RUN_ID_ROUTE.exec(pathname);
    if (req.method === "GET" && match) {
      handleGetRun(res, ctx, decodeURIComponent(match[1]!));
      return;
    }

    // Static assets + SPA fallback for the built viewer bundle — never for `/v0/*`, whose unmatched
    // routes must keep their JSON 404s so API deep-links don't silently receive HTML.
    if (req.method === "GET" && !isApiPath(pathname) && serveStatic(staticDir, pathname, res)) {
      return;
    }

    sendError(res, 404, "not found");
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export interface PathServerHandle {
  server: Server;
  /** The bound base URL, e.g. `http://localhost:54321` — known only once the OS assigns the port. */
  url: string;
  close(): Promise<void>;
}

/**
 * Boots `@path/server` against one fixed project root (server-api-v0.md §0): opens the same
 * `.path/path.db` `path run` would, in-process — no subprocess, no per-request project switching.
 * `port` defaults to an OS-assigned ephemeral port. Localhost-bind only, no auth (§0). `staticDir`
 * defaults to the built `@path/viewer` bundle (`packages/viewer/dist`); its assets are served — with
 * an SPA fallback to `index.html` — from the same origin as the `/v0/*` API (issue #42).
 */
export async function startPathServer(
  projectDir: string,
  port = 0,
  staticDir: string = DEFAULT_STATIC_DIR,
): Promise<PathServerHandle> {
  // One project for the process (#64): `.path/` ensured, engine settings loaded, db opened once —
  // the same three steps `path run` performs per invocation, now in one place that also owns how a
  // run's backends and observers are assembled.
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  const project = opened.project;

  const absStaticDir = resolve(staticDir);
  const ctx: RunsRouteContext = { project, live: createLiveRuns(project) };
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx, absStaticDir).catch((err) => {
      console.error(`unhandled request error: ${err instanceof Error ? err.stack : String(err)}`);
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });

  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    server,
    url: `http://localhost:${actualPort}`,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => {
          project.close();
          resolvePromise();
        });
      }),
  };
}
