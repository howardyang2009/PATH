import type { IncomingMessage, ServerResponse } from "node:http";

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
