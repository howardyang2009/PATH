import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import type { AuthoredLayout } from "../authored-layout.js";
import type { CreatorTable } from "../creator-table.js";
import type { LiveRuns } from "../live-runs.js";
import type { ServerMode } from "../mode.js";
import type { RequesterContext, RequesterContexts } from "../requester.js";

/** What one route handler is handed: the requester's authored layout and store, plus what the
 * process holds across requests. */
export interface RouteContext {
  /** The requester's store: where their runs are read and written. */
  project: Project;
  live: LiveRuns;
  /** The step-plugin registry frozen at server start (ADR 0018): scanned once, never per
   * request. */
  stepPlugins: LoadedStepPluginRegistry;
  /** The requester's authored layout: the files their doors read, and the ones they may write or
   * run. */
  layout: AuthoredLayout;
  /** Who created each shared item: the one table every requester's writes are checked against. */
  creators: CreatorTable;
}

/** What the process holds across every request: the runs it executes, the registry frozen at
 * start, and the resolver from a request to its requester context. */
export interface ServerContext {
  mode: ServerMode;
  live: LiveRuns;
  stepPlugins: LoadedStepPluginRegistry;
  requesters: RequesterContexts;
  creators: CreatorTable;
}

/** The context one request is handled under, built from the requester that request resolved to. */
export function routeContextFor(requester: RequesterContext, server: ServerContext): RouteContext {
  return {
    project: requester.store,
    layout: requester.layout,
    live: server.live,
    stepPlugins: server.stepPlugins,
    creators: server.creators,
  };
}

/** One matched request, decoded: the raw HTTP request for its headers and body, the requester's
 * context, and the decoded path parameters and query. A `reply` handler needs no response object,
 * so this is the whole interface a direct test has to build. */
export interface ApiRequest<Params extends string[] = string[]> {
  req: IncomingMessage;
  ctx: RouteContext;
  params: Params;
  query: URLSearchParams;
}

/** A request a `stream` route answers: the same, plus the response it owns (SSE, a file download).
 * Only the routes that cannot answer with a value take this. */
export interface StreamRequest<Params extends string[] = string[]> extends ApiRequest<Params> {
  res: ServerResponse;
}
