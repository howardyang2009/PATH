import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import type { AuthoredLayout } from "../authored-layout.js";
import type { CreatorTable } from "../creator-table.js";
import type { LiveRuns } from "../live-runs.js";
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

/** What `GET /v0/auth-config` tells a client: the mode, and the key it signs in with. */
export interface AuthConfig {
  mode: "local" | "hosted";
  publishableKey: string | null;
}

/** What the process holds across every request: the runs it executes, the registry frozen at
 * start, and the resolver from a request to its requester context. */
export interface ServerContext {
  authConfig: AuthConfig;
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

/** One matched request: the raw HTTP pair, the context, and what the path and query decoded to. */
export interface ApiRequest<Params extends string[] = string[]> {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: RouteContext;
  params: Params;
  query: URLSearchParams;
}
