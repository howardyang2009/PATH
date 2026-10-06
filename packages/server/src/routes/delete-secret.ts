import { type RouteReply, replyError } from "../http-json.js";
import { secretNameRefusal } from "../secret-store.js";
import type { ApiRequest } from "./route-context.js";

/** `DELETE /v0/secrets/:name` (server-api-v0.md §11): remove one User secret. A malformed or
 * reserved name is a `400`; an unknown name is a `404`, as is local mode. */
export function handleDeleteSecret({ ctx, params: [name] }: ApiRequest<[string]>): RouteReply {
  if (ctx.secrets === undefined) return replyError(404, "not found");
  const refusal = secretNameRefusal(name);
  if (refusal !== undefined) return replyError(400, refusal);
  if (!ctx.secrets.remove(name)) return replyError(404, `no User secret named "${name}"`);
  return { status: 204 };
}
