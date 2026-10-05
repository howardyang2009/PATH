import type { RouteReply } from "../http-json.js";
import type { ServerMode } from "../mode.js";

/** `GET /v0/auth-config`: the mode and the key a client signs in with. Public, and never the
 * verification settings. */
export function authConfigReply(mode: ServerMode): RouteReply {
  return { status: 200, body: { mode: mode.mode, publishableKey: mode.publishableKey } };
}
