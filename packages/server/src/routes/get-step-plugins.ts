import { type StepPluginsResponse, toWireStepPlugins } from "@path/schema";
import type { RouteReply } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/** `GET /v0/step-plugins` (server-api-v0.md §8): the step-plugin registry frozen at server
 * start. */
export function handleGetStepPlugins({ ctx }: ApiRequest): RouteReply {
  const body: StepPluginsResponse = toWireStepPlugins(ctx.stepPlugins);
  return { status: 200, body };
}
