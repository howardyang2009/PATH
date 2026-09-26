import type { IncomingMessage, ServerResponse } from "node:http";
import type { LoadedStepPluginRegistry, Project } from "@path/engine";
import type { LiveRuns } from "../live-runs.js";

/** What every route handler is handed: the one project this server serves, and what it holds for it. */
export interface RouteContext {
  project: Project;
  live: LiveRuns;
  /** The step-plugin registry frozen at server start (ADR 0018): scanned once, never per request. */
  stepPlugins: LoadedStepPluginRegistry;
  shippedTemplateDir?: string;
}

/** One matched request: the raw HTTP pair, the context, and what the path and query decoded to. */
export interface ApiRequest<Params extends string[] = string[]> {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: RouteContext;
  params: Params;
  query: URLSearchParams;
}
