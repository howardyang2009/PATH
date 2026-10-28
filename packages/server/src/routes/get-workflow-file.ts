import { readArtifact } from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { strongEtag } from "../etag.js";
import { type RouteReply, replyError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.1): the raw read half of the
 * write door — the exact on-disk bytes as `text` plus their strong `etag`, both in the body so a
 * proxy cannot weaken the token. It never validates, so an id-less file is served here and rejected
 * by `PUT` (ADR 0015). The three 404 causes collapse to one.
 */
export function handleGetWorkflowFile({ ctx, query }: ApiRequest): RouteReply {
  const path = query.get("path");
  if (path === null || path === "") return replyError(404, "request.not-found");

  const absPath = confineToProjectRoot(ctx.layout.projectDir, path);
  if (absPath === undefined || !ctx.layout.inView(path))
    return replyError(404, "request.not-found");

  // Confinement passed but the read can still fail — the file vanished, or the path names a
  // directory.
  const bytes = readArtifact(absPath);
  if (bytes === undefined) return replyError(404, "request.not-found");

  const etag = strongEtag(bytes);
  return { status: 200, headers: { ETag: etag }, body: { text: bytes.toString("utf8"), etag } };
}
