import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "../http-json.js";
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
import { handleGetTemplates } from "./get-templates.js";
import { handleGetWorkflowFile } from "./get-workflow-file.js";
import { handleGetWorkflows } from "./get-workflows.js";
import { handleListRuns } from "./list-runs.js";
import { handlePostRuns } from "./post-runs.js";
import { handlePostTemplates } from "./post-templates.js";
import { handlePutTemplate } from "./put-template.js";
import { handlePutWorkflow } from "./put-workflow.js";
import { handleResumeRun } from "./resume-run.js";
import type { RouteContext } from "./route-context.js";
import { handleWorkflowLock, handleWorkflowLockHeartbeat, handleWorkflowLockRelease } from "./workflow-lock.js";

/**
 * The `/v0/*` API as one table (server-api-v0.md): each row is a method, a path — literal, or a pattern
 * whose captures are the path parameters — and the handler it reaches. Matching and parameter decoding
 * happen once, here; a handler receives its parameters already decoded.
 */

/** One matched request, as a handler reads it. */
interface ApiRequest {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: RouteContext;
  /** The path parameters, percent-decoded, in pattern order. */
  params: string[];
  query: URLSearchParams;
}

interface ApiRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string | RegExp;
  handle(request: ApiRequest): void | Promise<void>;
}

const RUN = /^\/v0\/runs\/([^/]+)$/;
const TEMPLATE = /^\/v0\/templates\/([^/]+)$/;

const API_ROUTES: readonly ApiRoute[] = [
  // Runs (§2–§6).
  { method: "POST", path: "/v0/runs", handle: ({ req, res, ctx }) => handlePostRuns(req, res, ctx) },
  { method: "GET", path: "/v0/runs", handle: ({ res, ctx, query }) => handleListRuns(res, ctx, query) },
  { method: "GET", path: RUN, handle: ({ res, ctx, params }) => handleGetRun(res, ctx, params[0]!) },
  { method: "DELETE", path: RUN, handle: ({ res, ctx, params, query }) => handleDeleteRun(res, ctx, params[0]!, query.get("force") === "true") },
  { method: "GET", path: /^\/v0\/runs\/([^/]+)\/events$/, handle: ({ req, res, ctx, params }) => handleGetRunEvents(req, res, ctx, params[0]!) },
  {
    method: "GET",
    path: /^\/v0\/runs\/([^/]+)\/blobs\/([^/]+)\/([^/]+)$/,
    handle: ({ res, ctx, params }) => handleGetRunBlob(res, ctx, params[0]!, params[1]!, params[2]!),
  },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/cancel$/, handle: ({ res, ctx, params }) => handleCancelRun(res, ctx, params[0]!) },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/resume$/, handle: ({ req, res, ctx, params }) => handleResumeRun(req, res, ctx, params[0]!) },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/complete$/, handle: ({ req, res, ctx, params }) => handleCompleteRun(req, res, ctx, params[0]!) },

  // Workflow files (§7). The Designer edit lease is three POSTs so `navigator.sendBeacon` can drive
  // release from `beforeunload` (ADR 0017); each carries its `/`-bearing path in the body.
  { method: "GET", path: "/v0/workflows", handle: ({ res, ctx }) => handleGetWorkflows(res, ctx) },
  { method: "PUT", path: "/v0/workflows", handle: ({ req, res, ctx }) => handlePutWorkflow(req, res, ctx) },
  { method: "GET", path: "/v0/workflows/file", handle: ({ res, ctx, query }) => handleGetWorkflowFile(res, ctx, query.get("path")) },
  {
    method: "DELETE",
    path: "/v0/workflows/file",
    handle: ({ req, res, ctx, query }) => handleDeleteWorkflow(req, res, ctx, query.get("path"), query.get("session_id")),
  },
  { method: "POST", path: "/v0/workflows/lock", handle: ({ req, res, ctx }) => handleWorkflowLock(req, res, ctx) },
  { method: "POST", path: "/v0/workflows/lock/heartbeat", handle: ({ req, res, ctx }) => handleWorkflowLockHeartbeat(req, res, ctx) },
  { method: "POST", path: "/v0/workflows/lock/release", handle: ({ req, res, ctx }) => handleWorkflowLockRelease(req, res, ctx) },

  // The step-plugin palette (§8).
  { method: "GET", path: "/v0/step-plugins", handle: ({ res, ctx }) => handleGetStepPlugins(res, ctx) },

  // Templates (§10, ADR 0050). The by-id lookup spans both kinds and origins, so it takes no `?kind=`.
  { method: "GET", path: "/v0/templates", handle: ({ res, ctx, query }) => handleGetTemplates(res, ctx, query.get("kind")) },
  { method: "POST", path: "/v0/templates", handle: ({ req, res, ctx }) => handlePostTemplates(req, res, ctx) },
  { method: "GET", path: TEMPLATE, handle: ({ res, ctx, params }) => handleGetTemplate(res, ctx, params[0]!) },
  { method: "PUT", path: TEMPLATE, handle: ({ req, res, ctx, params }) => handlePutTemplate(req, res, ctx, params[0]!) },
  { method: "DELETE", path: TEMPLATE, handle: ({ res, ctx, params }) => handleDeleteTemplate(res, ctx, params[0]!) },
];

/**
 * Answer `req` from the API table. `false` when no row matches, so the caller can fall through to its
 * own 404 or static mounts. A path parameter that is not valid percent-encoding is a `400`, not the
 * `500` a thrown `decodeURIComponent` would become.
 */
export async function dispatchApi(req: IncomingMessage, res: ServerResponse, ctx: RouteContext, url: URL): Promise<boolean> {
  for (const route of API_ROUTES) {
    if (route.method !== req.method) continue;
    const captures = matchPath(route.path, url.pathname);
    if (captures === undefined) continue;
    const params = decodeAll(captures);
    if (params === undefined) {
      sendError(res, 400, "malformed percent-encoding in the request path");
      return true;
    }
    await route.handle({ req, res, ctx, params, query: url.searchParams });
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
