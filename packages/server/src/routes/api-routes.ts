import type { IncomingMessage, ServerResponse } from "node:http";
import { bufferRequestBody, type RouteReply, replyError, sendReply } from "../http-json.js";
import { megabytes, type UserLimits } from "../request-limits.js";
import { handleCancelRun } from "./cancel-run.js";
import { handleCompleteRun } from "./complete-run.js";
import { handleDeleteRun } from "./delete-run.js";
import { handleDeleteSecret } from "./delete-secret.js";
import { handleDeleteTemplate } from "./delete-template.js";
import { handleDeleteWorkflow } from "./delete-workflow.js";
import { authConfigReply } from "./get-auth-config.js";
import { handleGetRun } from "./get-run.js";
import { handleGetRunBlob } from "./get-run-blob.js";
import { handleGetRunEvents } from "./get-run-events.js";
import { handleGetSecrets } from "./get-secrets.js";
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
import { handlePutSecret } from "./put-secret.js";
import { handlePutTemplate } from "./put-template.js";
import { handlePutWorkflow } from "./put-workflow.js";
import { handleResumeRun } from "./resume-run.js";
import {
  type ApiRequest,
  routeContextFor,
  type ServerContext,
  type StreamRequest,
} from "./route-context.js";
import {
  handleWorkflowLock,
  handleWorkflowLockHeartbeat,
  handleWorkflowLockRelease,
} from "./workflow-lock.js";

/**
 * The `/v0/*` API as one table (server-api-v0.md): each row is a method, a path — literal, or a
 * pattern whose captures are the path parameters — and the handler it reaches. Matching and
 * parameter decoding happen once, here; a handler receives its parameters already decoded.
 *
 * Two kinds of row. A **reply** handler returns a {@link RouteReply} and never touches a response,
 * so a test drives it directly. A **stream** handler owns the socket (SSE, a file download) and
 * takes the response; only those four rows do.
 */
type ApiRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string | RegExp;
  /** The run limit a hosted request must pass first: a VM launch, or an authored write. */
  gate?: "launch" | "write";
} & (
  | { handle(request: ApiRequest): RouteReply | Promise<RouteReply> }
  | { stream: (request: StreamRequest<[string]>) => void | Promise<void> }
);

const RUN = /^\/v0\/runs\/([^/]+)$/;
const TEMPLATE = /^\/v0\/templates\/([^/]+)$/;
const SECRET = /^\/v0\/secrets\/([^/]+)$/;

const API_ROUTES: readonly ApiRoute[] = [
  // Runs (§2–§6).
  { method: "POST", path: "/v0/runs", handle: handlePostRuns, gate: "launch" },
  { method: "GET", path: "/v0/runs", handle: handleListRuns },
  { method: "GET", path: RUN, handle: handleGetRun },
  { method: "DELETE", path: RUN, handle: handleDeleteRun },
  { method: "GET", path: /^\/v0\/runs\/([^/]+)\/events$/, stream: handleGetRunEvents },
  {
    method: "GET",
    path: /^\/v0\/runs\/([^/]+)\/blobs\/([^/]+)\/([^/]+)$/,
    handle: handleGetRunBlob,
  },
  { method: "POST", path: /^\/v0\/runs\/([^/]+)\/cancel$/, handle: handleCancelRun },
  {
    method: "POST",
    path: /^\/v0\/runs\/([^/]+)\/resume$/,
    handle: handleResumeRun,
    gate: "launch",
  },
  {
    method: "POST",
    path: /^\/v0\/runs\/([^/]+)\/complete$/,
    handle: handleCompleteRun,
    gate: "launch",
  },

  // Workflow files (§7). The Designer edit lease is three POSTs (ADR 0017); each carries its
  // `/`-bearing path in the body.
  { method: "GET", path: "/v0/workflows", handle: handleGetWorkflows },
  { method: "PUT", path: "/v0/workflows", handle: handlePutWorkflow, gate: "write" },
  { method: "GET", path: "/v0/workflows/file", stream: handleGetWorkflowFile },
  { method: "GET", path: "/v0/workflows/download", stream: handleGetWorkflowDownload },
  { method: "DELETE", path: "/v0/workflows/file", handle: handleDeleteWorkflow },
  { method: "POST", path: "/v0/workflows/copy", handle: handlePostWorkflowCopy, gate: "write" },
  { method: "POST", path: "/v0/workflows/lock", handle: handleWorkflowLock },
  { method: "POST", path: "/v0/workflows/lock/heartbeat", handle: handleWorkflowLockHeartbeat },
  { method: "POST", path: "/v0/workflows/lock/release", handle: handleWorkflowLockRelease },

  // The step-plugin palette (§8).
  { method: "GET", path: "/v0/step-plugins", handle: handleGetStepPlugins },

  // Templates (§10, ADR 0050). The by-id lookup spans both kinds and origins, so it takes no
  // `?kind=`.
  { method: "GET", path: "/v0/templates", handle: handleGetTemplates },
  { method: "POST", path: "/v0/templates", handle: handlePostTemplates, gate: "write" },
  { method: "GET", path: TEMPLATE, handle: handleGetTemplate },
  {
    method: "GET",
    path: /^\/v0\/templates\/([^/]+)\/download$/,
    stream: handleGetTemplateDownload,
  },
  { method: "PUT", path: TEMPLATE, handle: handlePutTemplate, gate: "write" },
  { method: "DELETE", path: TEMPLATE, handle: handleDeleteTemplate },

  // The requester's Secret store (§11, ADR 0089): write-only, and `404` in local mode.
  { method: "GET", path: "/v0/secrets", handle: handleGetSecrets },
  { method: "PUT", path: SECRET, handle: handlePutSecret },
  { method: "DELETE", path: SECRET, handle: handleDeleteSecret },
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
  // Public: a client reads the mode before it can sign in.
  if (req.method === "GET" && url.pathname === "/v0/auth-config") {
    sendReply(res, authConfigReply(server.mode));
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
      sendReply(res, replyError(401, "sign-in required: missing, invalid or expired bearer token"));
      return true;
    }
    const limits = server.limits?.config.forUser(requester.userId);
    if (!(await withinRequestLimits(req, res, server, requester.userId, limits))) return true;
    const run = server.limits?.run;
    const refusal =
      run === undefined || limits === undefined || route.gate === undefined
        ? undefined
        : route.gate === "launch"
          ? run.launchRefusal(requester.userId, limits)
          : run.storageRefusal(requester.userId, limits);
    if (refusal !== undefined) {
      const { status, message, retryAfterSeconds } = refusal;
      sendReply(res, {
        ...replyError(status, message),
        headers:
          retryAfterSeconds === undefined
            ? undefined
            : { "Retry-After": String(retryAfterSeconds) },
      });
      return true;
    }
    const params = decodeAll(captures);
    if (params === undefined) {
      sendReply(res, replyError(400, "malformed percent-encoding in the request path"));
      return true;
    }
    const request: ApiRequest = {
      req,
      ctx: routeContextFor(requester, server, limits),
      params,
      query: url.searchParams,
    };
    if ("stream" in route) {
      // The matched row's own pattern decides the capture arity; `decodeAll` returns exactly those.
      await route.stream({ ...request, res } as StreamRequest<[string]>);
    } else sendReply(res, await route.handle(request));
    return true;
  }
  return false;
}

/**
 * Count the request against the requester's rate and read its body under their size cap, answering
 * `429` or `413` and returning `false` past either. An SSE stream is one request, counted here at
 * connect. Local mode has no limits.
 */
async function withinRequestLimits(
  req: IncomingMessage,
  res: ServerResponse,
  server: ServerContext,
  userId: string,
  limits: UserLimits | undefined,
): Promise<boolean> {
  if (server.limits === undefined || limits === undefined) return true;
  const rate = server.limits.rate.take(userId, limits.requestsPerMinute);
  if (!rate.ok) {
    sendReply(res, {
      ...replyError(429, "too many requests: try again later"),
      headers: { "Retry-After": String(rate.retryAfterSeconds) },
    });
    return false;
  }
  if (req.method === "GET") return true;
  const body = await bufferRequestBody(req, limits.maxBodyBytes);
  if (body.ok) return true;
  sendReply(res, {
    ...replyError(413, `request body too large: at most ${megabytes(limits.maxBodyBytes)}`),
    headers: body.close ? { Connection: "close" } : undefined,
  });
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
