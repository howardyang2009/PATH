import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { sendError } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * Resolve `relPath` to an absolute path *inside* `projectDir`, or `undefined` when it must not be
 * read. This is the read/write door's confinement (server-api-v0.md §7, §7.1), stricter than
 * discovery's list-time skip:
 *
 * - Lexical `resolve` against the fixed root, then a `relative` check — a path that escapes the root
 *   (`..`, or an absolute path) yields `undefined`, the same stance `prepareWorkflow` takes.
 * - A per-**component** `lstat`: if any segment of the confined path is a symlink, `undefined`. A
 *   symlinked parent directory could otherwise redirect the read outside the root even when the
 *   lexical path stays inside, so the refusal is to *traverse* a symlink, not merely to list one.
 *
 * A missing component (`lstat` throws) also yields `undefined`: there is nothing to read, and the
 * caller folds it into the same 404 as an escape. `relFromRoot === ""` (the root itself) is refused
 * — it is a directory, not a file.
 */
export function confineToProjectRoot(projectDir: string, relPath: string): string | undefined {
  const absPath = resolve(projectDir, relPath);
  const relFromRoot = relative(projectDir, absPath);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || isAbsolute(relFromRoot)) return undefined;

  let current = projectDir;
  for (const segment of relFromRoot.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
  }
  return absPath;
}

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
export function handleGetWorkflowFile(res: ServerResponse, ctx: RunsRouteContext, path: string | null): void {
  if (path === null || path === "") {
    sendError(res, 404, "not found");
    return;
  }

  const absPath = confineToProjectRoot(resolve(ctx.project.dir), path);
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(absPath);
  } catch {
    // Confinement passed but the read failed — the file vanished between the two, or the path names a
    // directory. Either way there is no file to serve: the same 404.
    sendError(res, 404, "not found");
    return;
  }

  const etag = `"${createHash("sha256").update(bytes).digest("hex")}"`;
  res.writeHead(200, { "Content-Type": "application/json", ETag: etag });
  res.end(bytes);
}
