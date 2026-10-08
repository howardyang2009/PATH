import type { IncomingMessage, ServerResponse } from "node:http";
import { formatIssues } from "@path/schema";
import type { z } from "zod";

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

/** Bodies the dispatcher already read under a size cap; `readJsonBody` parses these instead of the
 * consumed stream. */
const bufferedBodies = new WeakMap<IncomingMessage, Buffer>();

/**
 * Read `req`'s whole body into memory, for {@link readJsonBody} to parse later. `false` when the
 * body is over `maxBytes`: a `Content-Length` over it is refused unread, a longer stream once it
 * passes the cap.
 */
export function bufferRequestBody(req: IncomingMessage, maxBytes: number): Promise<boolean> {
  if (Number(req.headers["content-length"] ?? 0) > maxBytes) return Promise.resolve(false);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      req.off("data", onData);
      resolve(false);
    };
    req.on("data", onData);
    req.on("end", () => {
      bufferedBodies.set(req, Buffer.concat(chunks));
      resolve(true);
    });
    req.on("error", () => resolve(false));
  });
}

function readBodyBytes(req: IncomingMessage): Promise<Buffer | undefined> {
  const buffered = bufferedBodies.get(req);
  if (buffered !== undefined) return Promise.resolve(buffered);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(undefined));
  });
}

/** Reads and JSON-parses a request body; `ok: false` marks a body that isn't valid JSON. */
export async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const bytes = await readBodyBytes(req);
  if (bytes === undefined) return { ok: false };
  const raw = bytes.toString("utf8");
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Read a request body, JSON-parse it, and check it against `schema` — the prologue every
 * body-bearing route shares. A refusal is the `400` **as a reply**, so the caller returns it rather
 * than writing a response; `raw` is the parsed JSON before the schema touched it, for a route that
 * must keep the author's key order.
 */
export async function readRequestBody<T>(
  req: IncomingMessage,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T; raw: unknown } | { ok: false; reply: RouteReply }> {
  const body = await readJsonBody(req);
  if (!body.ok) return { ok: false, reply: replyError(400, "request body must be valid JSON") };
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    return {
      ok: false,
      reply: replyError(400, "invalid request body", formatIssues(parsed.error)),
    };
  }
  return { ok: true, data: parsed.data, raw: body.value };
}
