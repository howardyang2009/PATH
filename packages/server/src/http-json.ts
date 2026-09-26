import type { IncomingMessage, ServerResponse } from "node:http";
import { formatIssues } from "@path/schema";
import type { z } from "zod";

/** Shared error shape (server-api-v0.md §1) for every non-2xx response. */
export function sendError(res: ServerResponse, status: number, message: string, details?: unknown): void {
  sendJson(res, status, details === undefined ? { error: { message } } : { error: { message, details } });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Reads and JSON-parses a request body; `null` marks a body that isn't valid JSON. */
export function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({ ok: true, value: {} });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false });
      }
    });
    req.on("error", () => resolve({ ok: false }));
  });
}

/**
 * Read a request body, JSON-parse it, and check it against `schema` — the prologue every body-bearing
 * route shares. `undefined` once the `400` has been sent: invalid JSON, or a body the schema rejects
 * (with zod's issues as `details`). `raw` is the parsed JSON before the schema touched it, for a route
 * that must keep the author's key order.
 */
export async function readRequestBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: z.ZodType<T>,
): Promise<{ data: T; raw: unknown } | undefined> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "request body must be valid JSON");
    return undefined;
  }
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    sendError(res, 400, "invalid request body", formatIssues(parsed.error));
    return undefined;
  }
  return { data: parsed.data, raw: body.value };
}
