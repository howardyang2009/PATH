import { createReadStream, existsSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative } from "node:path";

/**
 * Extension → `Content-Type` for the asset kinds a built viewer bundle ships. Anything unlisted
 * falls back to `application/octet-stream` (a safe download, not a guess).
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** Resolves `pathname` against `rootDir`, refusing anything that escapes the root (path traversal). */
function resolveWithin(rootDir: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const candidate = join(rootDir, decoded);
  const rel = relative(rootDir, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return candidate;
}

function sendFile(res: ServerResponse, filePath: string): void {
  res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
  createReadStream(filePath).pipe(res);
}

/**
 * Serves one built bundle from `rootDir` (issue #42, mounts #360): `suffix` is the request path
 * **after the mount prefix is stripped** (e.g. `/designer/assets/x.js` arrives here as
 * `/assets/x.js`), so a request that names an existing file gets that file with its correct
 * `Content-Type`; the mount root (`/`) and every other suffix get this mount's own `index.html` so
 * its SPA client-side routes deep-link — never the other mount's bundle. Returns `false` (leaving
 * the caller to 404) when there is nothing to serve — an escaping path, or a missing `index.html`
 * (e.g. this bundle not built yet).
 *
 * The caller strips the mount prefix and keeps `/v0/*` out: unmatched API routes keep their JSON 404s.
 */
export function serveStatic(rootDir: string, suffix: string, res: ServerResponse): boolean {
  const target = resolveWithin(rootDir, suffix);
  if (target && suffix !== "/" && existsSync(target) && statSync(target).isFile()) {
    sendFile(res, target);
    return true;
  }

  // SPA fallback (and the bare `/` root): serve index.html when the bundle exists.
  const indexPath = join(rootDir, "index.html");
  if (existsSync(indexPath)) {
    sendFile(res, indexPath);
    return true;
  }
  return false;
}
