import { sendError } from "../http-json.js";
import { templatesOf } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";
import { sendDownload } from "./send-download.js";

/**
 * `GET /v0/templates/:id/download` (server-api-v0.md §10.6): the template's on-disk bytes as a
 * file, shipped ones included; an invalid template downloads too. Unknown id → `404`.
 */
export function handleGetTemplateDownload({ res, ctx, params: [id] }: ApiRequest<[string]>): void {
  const file = templatesOf(ctx).download(id);
  if (file === undefined) {
    sendError(res, 404, "not found");
    return;
  }
  sendDownload(res, { contentType: "application/json", ...file });
}
