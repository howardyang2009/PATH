import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadedStepPluginRegistry, loadStepPluginRegistry, openProject } from "@path/engine";
import { authoredLayout } from "./authored-layout.js";
import { clerkUserIdResolver } from "./clerk-identity.js";
import { adoptSharedItems, openCreatorTable } from "./creator-table.js";
import { enforceFunnelGuard, funnelGuardEnabled } from "./funnel-guard.js";
import { sendError } from "./http-json.js";
import { readServerMode } from "./mode.js";
import { enforceSameOrigin } from "./origin-gate.js";
import { createRequesterContexts } from "./requester.js";
import { dispatchApi } from "./routes/api-routes.js";
import type { ServerContext } from "./routes/route-context.js";
import { reapSandboxes } from "./sandbox/reaper.js";
import { readSandboxOptions } from "./sandbox/sandbox-config.js";
import { serveStatic } from "./serve-static.js";

/** Built `@path/viewer` bundle (`packages/viewer/dist`); `serveStatic` 404s when it is absent or
 * unbuilt. */
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../viewer/dist", import.meta.url));

/** Built `@path/designer` bundle (`packages/designer/dist`); its mount 404s (never crashes) until
 * built. */
const DEFAULT_DESIGNER_STATIC_DIR = fileURLToPath(new URL("../../designer/dist", import.meta.url));

/** The two hardcoded mounts (ADR 0027) — not an open table. Prefix has no trailing slash. */
const VIEWER_PREFIX = "/viewer";
const DESIGNER_PREFIX = "/designer";

/** True for the `/v0/*` API namespace, whose unmatched routes keep their JSON 404s (never SPA
 * HTML). */
function isApiPath(pathname: string): boolean {
  return pathname === "/v0" || pathname.startsWith("/v0/");
}

/** The request suffix within a mount, or `undefined` when `pathname` is not under `prefix`. Bare
 * `/designer` and `/designer/` both map to `/` (the mount root, answered with the bundle's
 * `index.html`). */
function mountSuffix(prefix: string, pathname: string): string | undefined {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return undefined;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  server: ServerContext,
  staticDir: string,
  designerStaticDir: string,
  funnelGuard: boolean,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    // Local mode fails closed when a forgotten Funnel exposes this unauthenticated, in-process run
    // executor (funnel-guard.ts).
    if (!enforceFunnelGuard(req, res, funnelGuard)) return;

    // Gate every non-GET route here, not per-route, so a future mutating route can't ship ungated
    // (origin-gate.ts).
    if (req.method !== "GET" && req.method !== "HEAD" && !enforceSameOrigin(req, res)) return;

    if (await dispatchApi(req, res, server, url)) return;

    // Bare `/` redirects to the default surface; 302 (not 301) keeps the target a changeable,
    // uncached line.
    if (req.method === "GET" && pathname === "/") {
      res.writeHead(302, { Location: `${VIEWER_PREFIX}/` });
      res.end();
      return;
    }

    // Named mounts: a GET is routed by prefix, the prefix stripped, the suffix resolved in that
    // bundle's dir with its own SPA fallback. An unbuilt bundle falls through to the plain 404
    // below.
    if (req.method === "GET" && !isApiPath(pathname)) {
      const viewerSuffix = mountSuffix(VIEWER_PREFIX, pathname);
      if (viewerSuffix !== undefined && serveStatic(staticDir, viewerSuffix, res)) return;

      const designerSuffix = mountSuffix(DESIGNER_PREFIX, pathname);
      if (designerSuffix !== undefined && serveStatic(designerStaticDir, designerSuffix, res))
        return;
    }

    sendError(res, 404, "not found");
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

export interface PathServerHandle {
  server: Server;
  /** The bound base URL, e.g. `http://localhost:54321` — known only once the OS assigns the
   * port. */
  url: string;
  close(): Promise<void>;
}

/**
 * Boots `@path/server` against one fixed project root (server-api-v0.md §0): one in-process
 * `.path/path.db`, localhost-bind, no auth. `staticDir`/`designerStaticDir` mount at `/viewer/` and
 * `/designer/` with their own SPA fallbacks; bare `/` 302s to `/viewer/`. `stepPlugins` is a test
 * seam.
 */
export async function startPathServer(
  projectDir: string,
  port = 0,
  staticDir: string = DEFAULT_STATIC_DIR,
  designerStaticDir: string = DEFAULT_DESIGNER_STATIC_DIR,
  stepPlugins?: LoadedStepPluginRegistry,
  shippedTemplateDir?: string,
  shippedWorkflowDir?: string,
): Promise<PathServerHandle> {
  // A half-configured hosted setup throws here, before anything is opened.
  const mode = readServerMode();

  // Scan the plugin folder (server-api-v0.md §8) before `openProject`, so a broken folder throws
  // without leaving an opened db handle behind; a thrown error skips the handle that would close
  // it.
  const registry = stepPlugins ?? (await loadStepPluginRegistry());

  // The project's own store, opened at boot: every local-mode requester resolves to it, and a bad
  // settings file or db refuses to start.
  const opened = openProject(projectDir);
  if (!opened.success) throw new Error(opened.error);
  const project = opened.project;

  const absStaticDir = resolve(staticDir);
  const absDesignerStaticDir = resolve(designerStaticDir);
  const funnelGuard = funnelGuardEnabled(mode);
  // One requester context per user, resolved per request (requester.ts). Local mode keeps every run
  // in the boot project's store; hosted mode gives each user their own.
  const shipped = { template: shippedTemplateDir, workflow: shippedWorkflowDir };
  const sandbox = mode.mode === "hosted" ? readSandboxOptions() : undefined;
  // VMs and staging a previous Server process left behind, cleared before any run starts.
  if (sandbox !== undefined) await reapSandboxes(projectDir, sandbox);
  const requesters = createRequesterContexts({
    projectDir,
    shippedDir: shipped,
    projectStore: project,
    resolveUserId: mode.mode === "hosted" ? clerkUserIdResolver(mode.clerk) : undefined,
    hosted: mode.mode === "hosted",
    secretsKey: mode.mode === "hosted" ? mode.secretsKey : undefined,
    sandbox,
  });
  // The host-level creator table (ADR 0088 §3). Local mode adopts today's untracked `shared/` files
  // as created by `local`, so they stay editable.
  const creators = openCreatorTable(join(project.dir, ".path", "host.db"));
  if (mode.mode === "local") {
    adoptSharedItems(authoredLayout({ projectDir, shippedDir: shipped }), creators);
  }
  const server: ServerContext = { mode, stepPlugins: registry, requesters, creators };
  const httpServer = createServer((req, res) => {
    handleRequest(req, res, server, absStaticDir, absDesignerStaticDir, funnelGuard).catch(
      (err) => {
        console.error(`unhandled request error: ${err instanceof Error ? err.stack : String(err)}`);
      },
    );
  });

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolvePromise());
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    server: httpServer,
    url: `http://localhost:${actualPort}`,
    close: () =>
      new Promise((resolvePromise, reject) => {
        httpServer.close(() => {
          // `server.close` only drains HTTP connections; runs are fire-and-forget, so drain them
          // before closing the store or a still-running step hits `The database connection is not
          // open`.
          requesters.idle().then(() => {
            requesters.close();
            creators.close();
            resolvePromise();
          }, reject);
        });
      }),
  };
}
