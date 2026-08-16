import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./http-json.js";

/**
 * CSRF/origin gate for the state-changing routes (issue #237).
 *
 * The server is no-auth, localhost-bind, single-origin: it serves the `@path/viewer` bundle and the
 * `/v0` API from one origin, with no CORS headers (#42). That was safe for the CLI and the read-only
 * viewer, but the browser launch surface (#228) added a threat neither had — a malicious site the
 * operator has open in another tab can `fetch("http://localhost:<port>/v0/runs", …)` and fire an
 * unwanted launch (classic CSRF). The residual risk is the *side effect of that launch*, not data
 * exfiltration: the operator's secret is typed per-launch and never stored in the browser, and the
 * same-origin policy blocks reading the response cross-origin.
 *
 * This is the cheap first line #237 asks for — a header check, still no auth. A cross-origin browser
 * fetch carries `Sec-Fetch-Site: cross-site` (or an `Origin` that doesn't match `Host`); the viewer's
 * own same-origin fetch and every non-browser client (the CLI, curl — outside the CSRF threat model)
 * do not. It graduates to token auth if remote access ever becomes a real destination
 * (server-api-v0.md §0).
 */

/** Duplicate request headers arrive as an array; the gate reads the first value. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when a state-changing request looks like a cross-origin browser call, i.e. the CSRF vector
 * #237 guards. Not exported through the package index — the server wires it into its route table.
 */
export function isCrossOriginWrite(req: IncomingMessage): boolean {
  const secFetchSite = firstHeader(req.headers["sec-fetch-site"]);
  if (secFetchSite !== undefined) {
    // A Fetch-Metadata-aware browser tells us directly where the request came from. `same-origin` is
    // the viewer we serve; `none` is a user-initiated load (address bar, bookmark) with no initiating
    // document — not a cross-site page. Everything else (`cross-site`, `same-site`) is refused.
    return secFetchSite !== "same-origin" && secFetchSite !== "none";
  }

  // No Fetch-Metadata: an older browser, or a non-browser client. Fall back to Origin vs Host. A
  // cross-origin browser fetch still sends `Origin`; a non-browser client (the CLI, curl) sends
  // neither header and is not a CSRF vector, so an absent Origin is allowed.
  const origin = firstHeader(req.headers.origin);
  if (origin === undefined) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // A malformed Origin, or the opaque-origin sentinel `"null"`, is not a same-origin caller.
    return true;
  }
  return originHost !== firstHeader(req.headers.host);
}

/**
 * Guards a state-changing route: on a cross-origin browser call, answers `403` and returns `false`
 * (the caller must stop); otherwise returns `true` and the handler proceeds.
 */
export function enforceSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isCrossOriginWrite(req)) {
    sendError(res, 403, "cross-origin request rejected");
    return false;
  }
  return true;
}
