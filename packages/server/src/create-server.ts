import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStepPluginRegistry, openProject, type LoadedStepPluginRegistry } from "@path/engine";
import { sendError } from "./http-json.js";
import { handleCancelRun } from "./routes/cancel-run.js";
import { handleDeleteRun } from "./routes/delete-run.js";
import { handleResumeRun } from "./routes/resume-run.js";
import { handleGetRun } from "./routes/get-run.js";
import { handleGetRunBlob } from "./routes/get-run-blob.js";
import { handleGetRunEvents } from "./routes/get-run-events.js";
import { handleListRuns } from "./routes/list-runs.js";
import { handleGetWorkflows } from "./routes/get-workflows.js";
import { handleGetWorkflowFile } from "./routes/get-workflow-file.js";
import { handleGetStepPlugins } from "./routes/get-step-plugins.js";
import { createLiveRuns } from "./live-runs.js";
import { enforceSameOrigin } from "./origin-gate.js";
import { handlePostRuns, type RunsRouteContext } from "./routes/post-runs.js";
import { handlePutWorkflow } from "./routes/put-workflow.js";
import {
  handleWorkflowLock,
  handleWorkflowLockHeartbeat,
  handleWorkflowLockRelease,
} from "./routes/workflow-lock.js";
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

/**
 * Where `path-server` looks for the built `@path/designer` bundle when no `designerStaticDir` is
 * passed: `packages/designer/dist`, resolved relative to this package. The Designer bundle does not
 * exist yet (#360) — its mount degrades to a 404 (never a crash) until it is built, exactly like the
 * Viewer's when unbuilt.
 */
const DEFAULT_DESIGNER_STATIC_DIR = fileURLToPath(new URL("../../designer/dist", import.meta.url));

/** The two hardcoded mounts (#360, ADR 0027) — not an open table. Prefix has no trailing slash. */
const VIEWER_PREFIX = "/viewer";
const DESIGNER_PREFIX = "/designer";

/** True for the `/v0/*` API namespace, whose unmatched routes keep their JSON 404s (never SPA HTML). */
function isApiPath(pathname: string): boolean {
  return pathname === "/v0" || pathname.startsWith("/v0/");
}

/**
 * The request suffix within a mount, or `undefined` when `pathname` is not under `prefix`. Bare
 * `/designer` and `/designer/` both map to `/` (the mount root, which `serveStatic` answers with the
 * bundle's `index.html`); `/designer/assets/x.js` maps to `/assets/x.js`.
 */
function mountSuffix(prefix: string, pathname: string): string | undefined {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return undefined;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  staticDir: string,
  designerStaticDir: string,
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
      await handleGetWorkflows(res, ctx);
      return;
    }

    if (req.method === "PUT" && pathname === "/v0/workflows") {
      await handlePutWorkflow(req, res, ctx);
      return;
    }

    if (req.method === "GET" && pathname === "/v0/workflows/file") {
      handleGetWorkflowFile(res, ctx, url.searchParams.get("path"));
      return;
    }

    // The Designer edit-lock lease (#364, ADR 0017): three POST routes so `navigator.sendBeacon` can
    // drive release from `beforeunload`. Each carries the `/`-bearing path in the body and reuses the
    // write door's confine/symlink stance; each is already origin-gated centrally above.
    if (req.method === "POST" && pathname === "/v0/workflows/lock") {
      await handleWorkflowLock(req, res, ctx);
      return;
    }

    if (req.method === "POST" && pathname === "/v0/workflows/lock/heartbeat") {
      await handleWorkflowLockHeartbeat(req, res, ctx);
      return;
    }

    if (req.method === "POST" && pathname === "/v0/workflows/lock/release") {
      await handleWorkflowLockRelease(req, res, ctx);
      return;
    }

    if (req.method === "GET" && pathname === "/v0/step-plugins") {
      handleGetStepPlugins(res, ctx);
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

    if (req.method === "DELETE" && match) {
      handleDeleteRun(res, ctx, decodeURIComponent(match[1]!), url.searchParams.get("force") === "true");
      return;
    }

    // Bare `/` redirects to the default surface. A 302 (not 301) keeps the default target a single
    // changeable line — no client caches the root as permanently the Viewer (#360, ADR 0027).
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(302, { Location: `${VIEWER_PREFIX}/` });
      res.end();
      return;
    }

    // Named mounts (#360): a GET is routed by prefix to one bundle, the prefix stripped, the suffix
    // resolved within that bundle's dir with its **own** SPA fallback to that bundle's `index.html`.
    // An unbuilt bundle (`serveStatic` returns false) falls through to the plain 404 below — never to
    // the other mount. `/v0/*` is excluded so its unmatched routes keep JSON 404s.
    if (req.method === "GET" && !isApiPath(pathname)) {
      const viewerSuffix = mountSuffix(VIEWER_PREFIX, pathname);
      if (viewerSuffix !== undefined && serveStatic(staticDir, viewerSuffix, res)) return;

      const designerSuffix = mountSuffix(DESIGNER_PREFIX, pathname);
      if (designerSuffix !== undefined && serveStatic(designerStaticDir, designerSuffix, res)) return;
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
 * defaults to the built `@path/viewer` bundle (`packages/viewer/dist`), mounted at `/viewer/`;
 * `designerStaticDir` defaults to `packages/designer/dist`, mounted at `/designer/`. Each mount's
 * assets are served — with an SPA fallback to its own `index.html` — from the same origin as the
 * `/v0/*` API (issue #42, #360). Bare `/` 302-redirects to `/viewer/`; an unbuilt bundle 404s.
 *
 * The step-plugin registry is scanned **once, here at start** (server-api-v0.md §8, ADR 0018): `GET
 * /v0/step-plugins` serves that frozen snapshot as the Designer's palette, and a broken plugin folder
 * fails the server loudly at start (ADR 0019 sub-16) rather than later on a workflow op. `stepPlugins`
 * is an injection seam for tests — a caller may hand in a hand-built registry (e.g. a >1-worker type)
 * instead of scanning the real folder — mirroring `runWorkflow`'s optional `registry`.
 */
export async function startPathServer(
  projectDir: string,
  port = 0,
  staticDir: string = DEFAULT_STATIC_DIR,
  designerStaticDir: string = DEFAULT_DESIGNER_STATIC_DIR,
  stepPlugins?: LoadedStepPluginRegistry,
): Promise<PathServerHandle> {
  // Fail loud at start on a broken plugin folder (§8), and freeze the palette snapshot for the
  // process. Scanned *before* `openProject` so a broken folder throws without leaving an opened db
  // handle behind — the project is closed only via the returned handle, which a throw here skips.
  const registry = stepPlugins ?? (await loadStepPluginRegistry());

  // One project for the process (#64): `.path/` ensured, engine settings loaded, db opened once —
  // the same three steps `path run` performs per invocation, now in one place that also owns how a
  // run's backends and observers are assembled.
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  const project = opened.project;

  const absStaticDir = resolve(staticDir);
  const absDesignerStaticDir = resolve(designerStaticDir);
  const ctx: RunsRouteContext = { project, live: createLiveRuns(project), stepPlugins: registry };
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx, absStaticDir, absDesignerStaticDir).catch((err) => {
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
