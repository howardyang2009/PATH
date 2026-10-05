import type { IncomingMessage, ServerResponse } from "node:http";
import { sendError } from "./http-json.js";
import type { ServerMode } from "./mode.js";
import { firstHeader } from "./origin-gate.js";

/**
 * The local-mode Funnel guard: a `*.ts.net` Host with no `Tailscale-User-Login` came through a
 * public Tailscale Funnel, so the Server refuses it and fails closed instead of exposing an
 * unauthenticated, in-process run executor (docs/spec/path-website.md §10).
 */

/** True for a Funnel request: a `*.ts.net` Host naming something, with no Serve identity header. */
export function isFunnelRequest(req: IncomingMessage): boolean {
  if (firstHeader(req.headers["tailscale-user-login"]) !== undefined) return false;
  const host = firstHeader(req.headers.host)?.toLowerCase();
  if (host === undefined) return false;
  const hostname = host.split(":")[0] ?? "";
  return hostname.replace(/\.$/, "").endsWith(".ts.net");
}

/** Whether the Funnel guard runs: local mode only, unless `PATH_FUNNEL_GUARD=off` switches it
 * off. */
export function funnelGuardEnabled(
  mode: ServerMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return mode.mode === "local" && env.PATH_FUNNEL_GUARD?.trim().toLowerCase() !== "off";
}

/** On a Funnel request in local mode answers `403` and returns `false` (the caller must stop). */
export function enforceFunnelGuard(
  req: IncomingMessage,
  res: ServerResponse,
  enabled: boolean,
): boolean {
  if (enabled && isFunnelRequest(req)) {
    sendError(
      res,
      403,
      "funnel guard: a *.ts.net Host without Tailscale-User-Login is a public Tailscale Funnel " +
        "request, which local mode refuses. Reach PATH over the tailnet (tailscale serve) or " +
        "set PATH_FUNNEL_GUARD=off to allow it",
    );
    return false;
  }
  return true;
}
