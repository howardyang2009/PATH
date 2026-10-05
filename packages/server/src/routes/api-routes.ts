import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError, sendJson } from "../http-json.js";
import { handleCancelRun } from "./cancel-run.js";
import { handleCompleteRun } from "./complete-run.js";
import { handleDeleteRun } from "./delete-run.js";
import { handleDeleteTemplate } from "./delete-template.js";
import { handleDeleteWorkflow } from "./delete-workflow.js";
import { handleGetRun } from "./get-run.js";
import { handleGetRunBlob } from "./get-run-blob.js";
import { handleGetRunEvents } from "./get-run-events.js";
import { handleGetStepPlugins } from "./get-step-plugins.js";
import { handleGetTemplate } from "./get-template.js";
import { handleGetTemplateDownload } from "./get-template-download.js";
import { handleGetTemplates } from "./get-templates.js";
import { handleGetWorkflowDownload } from "./get-workflow-download.js";
import { handleGetWorkflowFile } from "./get-workflow-file.js";
import { handleGetWorkflows } from "./get-workflows.js";
import { handleListRuns } from "./list-runs.js";
import { handlePostRuns } from "./post-runs.js";
import { handlePostTemplates } from "./post-templates.js";
import { handlePostWorkflowCopy } from "./post-workflow-copy.js";
import { handlePutTemplate } from "./put-template.js";
import { handlePutWorkflow } from "./put-workflow.js";
import { handleResumeRun } from "./resume-run.js";
import { type ApiRequest, routeContextFor, type ServerContext } from "./route-context.js";
import {
  handleWorkflowLock,
  handleWorkflowLockHeartbeat,
  handleWorkflowLockRelease,
} from "./workflow-lock.js";

/**
 * The `/v0/*` API as one table (server-api-v0.md): each row is a method, a path — literal, or a
 * pattern whose captures are the path parameters — and the handler it reaches. Matching and
 * parameter decoding happen once, here; a handler receives its parameters already decoded.
 */

/** One row of the table: the method and path it matches, and the handler that answers it. */
interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string | RegExp;
  handle(request: ApiRequest): void | Promise<void>;
}

const RUN = /^\/v0\/runs\/([^/]+)$/;
const TEMPLATE = /^\/v0\/templates\/([^/]+)$/;

const API_ROUTES: readonly ApiRoute[] = [
  // Runs (§2–§6).
  { method: "POST", path: "/v0/runs", handle: handlePostRuns },
  { method: "GET", path: "/v0/runs", handle: handleListRuns },
  { method: "GET", path: RUN, handle: handleGetRun },
  { method: "DELETE", path: RUN, handle: handleDeleteRun },
  { method: "GET", path: /^\/v0\/runs\/([^/]+)\/events$/, handle: handleGetRunEvents },
  {
    method: "GET",
    path: /^\/v0\/runs\/([^/]+)\/blobs\/([^/]+)\/([^/]+)$/,
    handle: handleGetRunBlob,
  },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/cancel$/, handle: handleCancelRun },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/resume$/, handle: handleResumeRun },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/complete$/, handle: handleCompleteRun },

  // Workflow files (§7). The Designer edit lease is three POSTs so `navigator.sendBeacon` can drive
  // release from `beforeunload` (ADR 0017); each carries its `/`-bearing path in the body.
  { method: "GET", path: "/v0/workflows", handle: handleGetWorkflows },
  { method: "PUT", path: "/v0/workflows", handle: handlePutWorkflow },
  { method: "GET", path: "/v0/workflows/file", handle: handleGetWorkflowFile },
  { method: "GET", path: "/v0/workflows/download", handle: handleGetWorkflowDownload },
  { method: "DELETE", path: "/v0/workflows/file", handle: handleDeleteWorkflow },
  { method: "POST", path: "/v0/workflows/copy", handle: handlePostWorkflowCopy },
  { method: "POST", path: "/v0/workflows/lock", handle: handleWorkflowLock },
  { method: "POST", path: "/v0/workflows/lock/heartbeat", handle: handleWorkflowLockHeartbeat },
  { method: "POST", path: "/v0/workflows/lock/release", handle: handleWorkflowLockRelease },

  // The step-plugin palette (§8).
  { method: "GET", path: "/v0/step-plugins", handle: handleGetStepPlugins },

  // Templates (§10, ADR 0050). The by-id lookup spans both kinds and origins, so it takes no
  // `?kind=`.
  { method: "GET", path: "/v0/templates", handle: handleGetTemplates },
  { method: "POST", path: "/v0/templates", handle: handlePostTemplates },
  { method: "GET", path: TEMPLATE, handle: handleGetTemplate },
  {
    method: "GET",
    path: /^\/v0\/templates\/([^/]+)\/download$/,
    handle: handleGetTemplateDownload,
  },
  { method: "PUT", path: TEMPLATE, handle: handlePutTemplate },
  { method: "DELETE", path: TEMPLATE, handle: handleDeleteTemplate },
];

/**
 * Answer `req` from the API table. `false` when no row matches, so the caller can fall through to
 * its own 404 or static mounts. A path parameter that is not valid percent-encoding is a `400`, not
 * the `500` a thrown `decodeURIComponent` would become.
 */
export async function dispatchApi(
  req: IncomingMessage,
  res: ServerResponse,
  server: ServerContext,
  url: URL,
): Promise<boolean> {
  // Public: a client reads the mode before it can sign in (ADR 0090 §4).
  if (req.method === "GET" && url.pathname === "/v0/auth-config") {
    sendJson(res, 200, server.authConfig);
    return true;
  }
  for (const route of API_ROUTES) {
    if (route.method !== req.method) continue;
    const captures = matchPath(route.path, url.pathname);
    if (captures === undefined) continue;
    // Resolved only once a row matches: an unmatched path keeps its plain 404, and the static
    // mounts stay public (ADR 0090).
    const requester = await server.requesters.forRequest(req);
    if (requester === undefined) {
      sendError(res, 401, "sign-in required: missing, invalid or expired bearer token");
      return true;
    }
    const params = decodeAll(captures);
    if (params === undefined) {
      sendError(res, 400, "malformed percent-encoding in the request path");
      return true;
    }
    await route.handle({
      req,
      res,
      ctx: routeContextFor(requester, server),
      params,
      query: url.searchParams,
    });
    return true;
  }
  return false;
}

/** The raw captures of `pathname` against `path`, or `undefined` when it does not match. */
function matchPath(path: string | RegExp, pathname: string): string[] | undefined {
  if (typeof path === "string") return path === pathname ? [] : undefined;
  const match = path.exec(pathname);
  return match ? match.slice(1) : undefined;
}

function decodeAll(captures: string[]): string[] | undefined {
  try {
    return captures.map((capture) => decodeURIComponent(capture));
  } catch {
    return undefined;
  }
}
