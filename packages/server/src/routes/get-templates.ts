import type { RouteReply } from "../http-json.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates?kind=step` (server-api-v0.md §10.1): the thin shipped∪shared∪user list, one summary
 * per entry, no `body`, each with its registry-relative `valid`/`error`, and the writable roots.
 */
export function handleGetTemplates({ ctx, query }: ApiRequest): RouteReply {
  const kind = query.get("kind") === "step" ? "step" : undefined;
  return { status: 200, body: templatesOf(ctx).list(kind) };
}
