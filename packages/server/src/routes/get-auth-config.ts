import type { ServerResponse } from "node:http";
import { sendJson } from "../http-json.js";
import type { ServerMode } from "../mode.js";

/** `GET /v0/auth-config`: the mode and the key a client signs in with. Public, and never the
 * verification settings. */
export function handleGetAuthConfig(res: ServerResponse, mode: ServerMode): void {
  sendJson(res, 200, { mode: mode.mode, publishableKey: mode.publishableKey });
}
