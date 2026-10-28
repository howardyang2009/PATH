import type { RouteReply } from "../http-json.js";
import { workflowsOf } from "../workflow-store.js";
import type { ApiRequest } from "./route-context.js";

/** `GET /v0/workflows` (server-api-v0.md §6, ADR 0085, ADR 0086): the requester's workflow
 * Discovery, as the workflow store lists it. */
export async function handleGetWorkflows({ ctx }: ApiRequest): Promise<RouteReply> {
  return { status: 200, body: await workflowsOf(ctx).list() };
}
