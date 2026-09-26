import { resolve } from "node:path";
import { readArtifact } from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { strongEtag } from "../etag.js";
import { sendError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/**
 * `GET /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.1): the raw read half of the
 * workflow write door, the byte source the Designer opens a file from and the ETag source `PUT
 * /v0/workflows`'s `If-Match` precondition needs.
 *
 * **Always raw, never the loader.** It streams the exact on-disk bytes as `application/json` and sets
 * a strong `ETag` (sha256 of those bytes, hex, double-quoted). It never validates: the ETag must hash
 * the bytes anyway, and the Designer needs the raw body to preserve unknown fields and to receive an
 * **id-less** file it stamps on import (ADR 0015). So this `GET` is lenient where `PUT` is strict —
 * an id-less file is served here, rejected there.
 *
 * A read has no side effect, so it is ungated (§2.1). The path rides a query param — a `GET` carries
 * no body — and stays an opaque `/`-bearing string. The three 404 causes collapse to one response:
 * the file is not there, `path` escapes the root, or a path component is a symlink.
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

  // Confinement passed but the read can still fail — the file vanished between the two, or the path
  // names a directory. Either way there is no file to serve: the same 404.
  const bytes = readArtifact(absPath);
  if (bytes === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json", ETag: strongEtag(bytes) });
  res.end(bytes);
}
