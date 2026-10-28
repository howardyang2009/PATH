import { locateAuthoredFile } from "../authored-read.js";
import { type RouteReply, replyError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.1): the raw read half of the
 * write door — the exact on-disk bytes as `text` plus their strong `etag`, both in the body so a
 * proxy cannot weaken the token. It never validates, so an id-less file is served here and rejected
 * by `PUT` (ADR 0015). The file is resolved through the one authored read seam, and every miss
 * collapses to one 404.
 */
export function handleGetWorkflowFile({ ctx, query }: ApiRequest): RouteReply {
  const path = query.get("path");
  const read = path === null ? null : locateAuthoredFile(ctx.layout, path);
  if (read === null || !read.ok) return replyError(404, "request.not-found");

  const { bytes, etag } = read.file;
  return { status: 200, headers: { ETag: etag }, body: { text: bytes.toString("utf8"), etag } };
}
