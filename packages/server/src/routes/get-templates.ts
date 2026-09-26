import { sendJson } from "../http-json.js";
import { type TemplateKind, templateSummary, templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/templates?kind=step` (server-api-v0.md §10.1): the thin shipped∪user list, one summary per entry, no
 * `body`, each with its registry-relative `valid`/`error`.
 */
export function handleGetTemplates({ res, ctx, query }: ApiRequest): void {
  const kindParam = query.get("kind");

  const { entries } = templatesOf(ctx);

  const filter: TemplateKind | undefined = kindParam === "step" ? kindParam : undefined;

  const templates = entries
    .filter((e) => filter === undefined || e.kind === filter)
    .map(templateSummary);

  sendJson(res, 200, { templates });
}
