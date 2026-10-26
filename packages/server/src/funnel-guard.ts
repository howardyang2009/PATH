import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./http-json.js";
import type { ServerMode } from "./mode.js";
import { firstHeader } from "./origin-gate.js";

/**
 * The local-mode guard: local mode answers only a loopback `Host` or a `tailscale serve` request,
 * and refuses every other ingress (Funnel, Cloudflare Tunnel, a port-forward), so it fails closed
 * instead of exposing an unauthenticated, in-process run executor (docs/spec/path-website.md §10).
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Headers a reverse proxy or Cloudflare adds; a loopback `Host` that carries one was proxied. */
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "forwarded"];

function hostnameOf(host: string): string {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return (name ?? "").toLowerCase().replace(/\.$/, "");
}

/** True unless the request is plain loopback use or a tailnet request through `tailscale serve`. */
export function isPublicRequest(req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host);
  if (host === undefined) return true;
  const hostname = hostnameOf(host);
  if (req.headers["cf-connecting-ip"] !== undefined || req.headers["cf-ray"] !== undefined) {
    return true;
  }
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
  }
  // `tailscale serve` sets the identity header and Funnel strips it.
  const isServe = firstHeader(req.headers["tailscale-user-login"]) !== undefined;
  return !(isServe && hostname.endsWith(".ts.net"));
}

/** Whether the guard runs: local mode only, unless `PATH_FUNNEL_GUARD=off` switches it off. */
export function funnelGuardEnabled(
  mode: ServerMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return mode.mode === "local" && env.PATH_FUNNEL_GUARD?.trim().toLowerCase() !== "off";
}

/** On a public request in local mode answers `403` and returns `false` (the caller must stop). */
export function enforceFunnelGuard(
  req: IncomingMessage,
  res: ServerResponse,
  enabled: boolean,
): boolean {
  if (enabled && isPublicRequest(req)) {
    sendError(res, 403, "request.funnel-guard");
    return false;
  }
  return true;
}
