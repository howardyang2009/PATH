import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { dbFilePath, ensurePathDirGitignore, openDb, pathDir } from "@path/engine";
import type Database from "better-sqlite3";
import { sendError } from "./http-json.js";
import { handleGetRun } from "./routes/get-run.js";
import { handleGetRunEvents } from "./routes/get-run-events.js";
import { handleListRuns } from "./routes/list-runs.js";
import { handlePostRuns, type RunsRouteContext } from "./routes/post-runs.js";
import { RunEventHub } from "./run-event-hub.js";

const RUN_ID_ROUTE = /^\/v0\/runs\/([^/]+)$/;
const RUN_EVENTS_ROUTE = /^\/v0\/runs\/([^/]+)\/events$/;

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RunsRouteContext): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (req.method === "POST" && pathname === "/v0/runs") {
      await handlePostRuns(req, res, ctx);
      return;
    }

    if (req.method === "GET" && pathname === "/v0/runs") {
      handleListRuns(res, ctx, url.searchParams);
      return;
    }

    const eventsMatch = RUN_EVENTS_ROUTE.exec(pathname);
    if (req.method === "GET" && eventsMatch) {
      handleGetRunEvents(req, res, ctx, decodeURIComponent(eventsMatch[1]!));
      return;
    }

    const match = RUN_ID_ROUTE.exec(pathname);
    if (req.method === "GET" && match) {
      handleGetRun(res, ctx, decodeURIComponent(match[1]!));
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
 * `port` defaults to an OS-assigned ephemeral port. Localhost-bind only, no auth (§0).
 */
export async function startPathServer(projectDir: string, port = 0): Promise<PathServerHandle> {
  const absProjectDir = resolve(projectDir);
  ensurePathDirGitignore(pathDir(absProjectDir));
  const db: Database.Database = openDb(dbFilePath(absProjectDir));

  const ctx: RunsRouteContext = { projectDir: absProjectDir, db, hub: new RunEventHub() };
  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
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
          db.close();
          resolvePromise();
        });
      }),
  };
}
