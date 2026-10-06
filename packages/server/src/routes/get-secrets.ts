import type { WireSecretList } from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

/** `GET /v0/secrets` (server-api-v0.md §11): the requester's User secret names and `updated_at`,
 * never a value. Local mode has no Secret store, so `404`. */
export function handleGetSecrets({ ctx }: ApiRequest): RouteReply {
  if (ctx.secrets === undefined) return replyError(404, "not found");
  const body: WireSecretList = { secrets: ctx.secrets.list() };
  return { status: 200, body };
}
