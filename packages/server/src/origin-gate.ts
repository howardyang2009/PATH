import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./http-json.js";

/** CSRF/origin gate for state-changing routes: refuse a cross-origin browser fetch (`Sec-Fetch-Site:
 * cross-site`, or `Origin` ≠ `Host`). No-auth, localhost-bind, so the residual risk is a launch's side
 * effect, not exfiltration; token auth only if remote access becomes real (server-api-v0.md §0). */

/** Duplicate request headers arrive as an array; read the first value. Shared with the write door. */
export function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** True when a state-changing request looks cross-origin. */
export function isCrossOriginWrite(req: IncomingMessage): boolean {
  const secFetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (secFetchSite !== undefined) {
    return secFetchSite !== "same-origin" && secFetchSite !== "none";
  }

  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return originHost !== firstHeader(req.headers.host);
}

/** On a cross-origin browser call answers `403` and returns `false` (the caller must stop). */
export function enforceSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isCrossOriginWrite(req)) {
    sendError(res, 403, "cross-origin request rejected");
    return false;
  }
  return true;
}
