import type { RouteReply } from "../http-json.js";
import { type TemplateKind, templateSummary, templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates?kind=step` (server-api-v0.md §10.1): the thin shipped∪shared∪user list, one summary
 * per entry, no `body`, each with its registry-relative `valid`/`error`.
 */
export function handleGetTemplates({ ctx, query }: ApiRequest): RouteReply {
  const kindParam = query.get("kind");

  const { entries } = templatesOf(ctx);

  const filter: TemplateKind | undefined = kindParam === "step" ? kindParam : undefined;

  const templates = entries
    .filter((e) => filter === undefined || e.kind === filter)
    .map(templateSummary);

  return { status: 200, body: { templates } };
}
