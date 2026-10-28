import type { ServerResponse } from "node:http";
import { type CodedError, type ErrorCode, type ErrorParams, errorText } from "@path/i18n";
import { formatIssues, type JsonValue, type WireError } from "@path/schema";
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

export type { ErrorParams };

/** A refusal PATH owns (ADR 0107): its code, the client's catalogue key, and the code's params. */
export type Refusal = CodedError;

/** A refusal's English text, from the `en` catalogue: the wire's fallback, logs and the CLI. */
export function refusalText({ code, params }: Refusal): string {
  return errorText(code, params);
}

/** The shared error envelope's `error` (server-api-v0.md §1, ADR 0107): the code and params the
 * client renders, plus `message` in English for `curl`, an old client and an unknown code. */
export function wireError(
  code: ErrorCode,
  params: ErrorParams = {},
  details?: unknown,
  message = errorText(code, params),
): WireError["error"] {
  // `details` is JSON by construction: issues, ajv errors or plain strings.
  const error = { code, params, message };
  return details === undefined ? error : { ...error, details: details as JsonValue };
}

/** A refusal in the shared error envelope (server-api-v0.md §1, ADR 0107): the code and params
 * the client renders, plus `message` in English for `curl`, an old client and an unknown code. */
export function replyError(
  status: number,
  code: ErrorCode,
  params: ErrorParams = {},
  details?: unknown,
): RouteReply {
  return { status, body: { error: wireError(code, params, details) } };
}

/** {@link replyError} for a refusal a helper module decided. */
export function replyRefusal(status: number, refusal: Refusal, details?: unknown): RouteReply {
  return replyError(status, refusal.code, refusal.params, details);
}

/** A refusal that names its own HTTP status, as a store, lookup or engine gate decides it. */
export interface StatusRefusal extends Refusal {
  status: number;
  details?: unknown;
}

/** {@link replyError} for a refusal that carries its own status and details. */
export function replyRefused(refusal: StatusRefusal): RouteReply {
  return replyError(refusal.status, refusal.code, refusal.params, refusal.details);
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
  code: ErrorCode,
  params?: ErrorParams,
  details?: unknown,
): void {
  sendReply(res, replyError(status, code, params, details));
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
      reply: replyError(400, "request.invalid-body", {}, formatIssues(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data, raw: body.raw };
}
