import { z } from "zod";
import { type RouteReply, readRequestBody, replyError } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

const PutSecretBodySchema = z.object({ value: z.string() }).strict();

/** `PUT /v0/secrets/:name` (server-api-v0.md §11): set or replace one User secret. The reply names
 * it and never echoes the value; a limit or a reserved name is a `400`. */
export async function handlePutSecret({
  req,
  ctx,
  params: [name],
}: ApiRequest<[string]>): Promise<RouteReply> {
  if (ctx.secrets === undefined) return replyError(404, "not found");
  const body = await readRequestBody(req, PutSecretBodySchema);
  if (!body.ok) return body.reply;
  const written = ctx.secrets.set(name, body.data.value);
  if (!written.ok) return replyError(400, written.message);
  return { status: 200, body: written.summary };
}
