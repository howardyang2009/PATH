import type { IncomingMessage } from "node:http";
import type { RouteReply } from "./http-json.js";
import { replyError } from "./http-json.js";
import { megabytes } from "./request-limits.js";

// The request body is read once, under the admission module's cap, at the one point that answers
// the request (admission.ts). A handler never touches the stream: it receives the decoded body as a
// value on `ApiRequest` (route-context.ts).

/** One request's body as a value: `present` is false for a method that carries none. */
export interface RequestBody {
  present: boolean;
  /** The parsed JSON; `{}` for a present but empty body, `undefined` for an absent one. */
  raw: unknown;
}

/** The body of a GET or HEAD, which carries none: no stream is touched. */
export const NO_BODY: RequestBody = { present: false, raw: undefined };

/** A body read under a cap: the value, or the refusal and whether the reply must close the
 * connection (an oversize body that was still being drained). */
export type CappedBody =
  | { ok: true; body: RequestBody }
  | { ok: false; reply: RouteReply; close: boolean };

/** How much past the cap an oversize body is still read and dropped, so the client gets to read the
 * `413`; a longer body is refused at once and its connection closed. */
const OVERSIZE_DRAIN_BYTES = 8 * 1024 * 1024;

/**
 * Read one request's whole body under `maxBytes`, JSON-parse it, and return it as a value: `413`
 * past the cap, `400` when the bytes are not JSON. `maxBytes === undefined` reads without a cap.
 */
export function readBodyUnderCap(
  req: IncomingMessage,
  maxBytes: number | undefined,
): Promise<CappedBody> {
  // A GET or HEAD carries no body by contract, so it is never read and never capped.
  if (req.method === "GET" || req.method === "HEAD") {
    return Promise.resolve({ ok: true, body: NO_BODY });
  }
  return bufferRequest(req, maxBytes).then((buffered) => {
    if (!buffered.ok) {
      return {
        ok: false,
        close: buffered.close,
        reply: {
          ...replyError(413, `request body too large: at most ${capLabel(maxBytes)}`),
          headers: buffered.close ? { Connection: "close" } : undefined,
        },
      };
    }
    let raw: unknown;
    try {
      raw = buffered.bytes === undefined ? {} : JSON.parse(buffered.bytes.toString("utf8"));
    } catch {
      return { ok: false, close: false, reply: replyError(400, "request body must be valid JSON") };
    }
    return { ok: true, body: { present: true, raw } };
  });
}

type BufferResult = { ok: true; bytes: Buffer | undefined } | { ok: false; close: boolean };

/** The cap as a reader sees it: a byte count, never a silent "unlimited". */
function capLabel(maxBytes: number | undefined): string {
  return maxBytes === undefined ? "unlimited" : megabytes(maxBytes);
}

function bufferRequest(req: IncomingMessage, maxBytes: number | undefined): Promise<BufferResult> {
  // No configured cap: the body is still read as a value, just never refused for its size.
  const limit = maxBytes ?? Number.POSITIVE_INFINITY;
  const drainLimit =
    maxBytes === undefined ? Number.POSITIVE_INFINITY : maxBytes + OVERSIZE_DRAIN_BYTES;
  // A declared length past even the drain window is refused before a byte arrives.
  if (Number(req.headers["content-length"] ?? 0) > drainLimit) {
    return Promise.resolve({ ok: false, close: true });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
      else if (size > drainLimit) {
        req.off("data", onData);
        req.pause();
        resolve({ ok: false, close: true });
      }
    };
    req.on("data", onData);
    req.on("end", () => {
      if (size > limit) {
        resolve({ ok: false, close: false });
        return;
      }
      resolve({ ok: true, bytes: chunks.length === 0 ? undefined : Buffer.concat(chunks) });
    });
    req.on("error", () => resolve({ ok: false, close: true }));
  });
}
