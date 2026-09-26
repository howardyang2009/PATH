import { resolve } from "node:path";
import { readArtifact } from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.1): the raw read half of the write
 * door — the exact on-disk bytes plus a strong `ETag` (sha256 of those bytes). It never validates, so an
 * id-less file is served here and rejected by `PUT` (ADR 0015). The three 404 causes collapse to one.
 */
export function handleGetWorkflowFile({ res, ctx, query }: ApiRequest): void {
  const path = query.get("path");

  if (path === null || path === "") {
    sendError(res, 404, "not found");
    return;
  }

  const absPath = confineToProjectRoot(resolve(ctx.project.dir), path);
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  // Confinement passed but the read can still fail — the file vanished, or the path names a directory.
  const bytes = readArtifact(absPath);
  if (bytes === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json", ETag: strongEtag(bytes) });
  res.end(bytes);
}
