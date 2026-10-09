import type { ServerResponse } from "node:http";
import { formatIssues } from "@path/schema";
import type { z } from "zod";
import type { RequestBody } from "./request-body.js";

/** What a `reply` route answers: the table writes it, so a handler holds no response object. */
export interface RouteReply {
  status: number;
  /** The JSON body; omitted for a `204`. */
  body?: unknown;
  /** Extra response headers, e.g. the write doors' `ETag`. */
  headers?: Record<string, string>;
}

/** A refusal in the shared error envelope (server-api-v0.md §1). */
export function replyError(status: number, message: string, details?: unknown): RouteReply {
  return {
    status,
    body: details === undefined ? { error: { message } } : { error: { message, details } },
  };
}

/** Write one `reply` route's answer. */
export function sendReply(res: ServerResponse, reply: RouteReply): void {
  if (reply.body === undefined) {
    res.writeHead(reply.status, reply.headers);
    res.end();
    return;
  }
  res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
  res.end(JSON.stringify(reply.body));
}

/** Shared error shape (server-api-v0.md §1) for every non-2xx response a `stream` route writes. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  details?: unknown,
): void {
  sendReply(res, replyError(status, message, details));
}

/**
 * Check the request body — already read and JSON-parsed at the one body seam (request-body.ts) —
 * against `schema`, the prologue every body-bearing route shares. A refusal is the `400` **as a
 * reply**, so the caller returns it rather than writing a response; `raw` is the parsed JSON before
 * the schema touched it, for a route that must keep the author's key order.
 */
export function readRequestBody<T>(
  body: RequestBody,
  schema: z.ZodType<T>,
): { ok: true; data: T; raw: unknown } | { ok: false; reply: RouteReply } {
  const parsed = schema.safeParse(body.raw);
  if (!parsed.success) {
    return {
      ok: false,
      reply: replyError(400, "invalid request body", formatIssues(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data, raw: body.raw };
}
