import type { JsonValue, WireError } from "@path/schema";

/** A minimal `fetch` shape — injectable so browser/React Native/tests can supply their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The default transport: the ambient global `fetch`, wrapped rather than passed by reference. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** How a hosted client signs its requests: `getToken` supplies the Bearer token (null sends none),
 * and `onUnauthorized` settles once the user has signed in again after a `401`. */
export interface RequestAuth {
  getToken: () => Promise<string | null>;
  onUnauthorized?: () => Promise<void>;
}

/** `fetch` with the Bearer token on every call. A `401` waits for `onUnauthorized`, then retries
 * once with the new token, so a call made before the session was lost still lands. */
export function authorizedFetch(fetch: FetchLike, auth: RequestAuth): FetchLike {
  const send = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const token = await auth.getToken();
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return async (input, init) => {
    const res = await send(input, init);
    if (res.status !== 401 || !auth.onUnauthorized) return res;
    await auth.onUnauthorized();
    return send(input, init);
  };
}

/** A non-2xx response from the server, carrying its parsed `{ error: { message, details? } }`
 * envelope (server-api-v0.md §1).
 */
export class PathApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: JsonValue,
  ) {
    super(message);
    this.name = "PathApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent as JSON, with a `Content-Type` to say so. */
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Reply {
  status: number;
  text: string;
  headers: Headers;
}

/** The HTTP layer every endpoint group shares: one base URL, one injected `fetch`. */
export class HttpTransport {
  constructor(
    readonly baseUrl: string,
    readonly fetch: FetchLike,
  ) {}

  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Sends `method` to `path` with a JSON `body` when given, handing back the raw reply whatever
   * its status. The lock doors use it directly, because a `409` there is an ordinary answer.
   */
  async send(path: string, options: RequestOptions = {}): Promise<Reply> {
    const { method = "GET", body, headers = {} } = options;
    const init: RequestInit =
      method === "GET"
        ? { headers: { Accept: "application/json", ...headers } }
        : {
            method,
            headers: {
              Accept: "application/json",
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
              ...headers,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          };
    const res = await this.fetch(this.url(path), init);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  /** `send`, with any non-2xx raised as the server's error envelope. The reply body is not parsed:
   * a caller that needs nothing back cannot fail on an empty or non-JSON 2xx.
   */
  async request(path: string, options?: RequestOptions): Promise<Reply> {
    const reply = await this.send(path, options);
    if (reply.status < 200 || reply.status >= 300) throw toApiError(reply.status, reply.text);
    return reply;
  }

  /** A GET whose 2xx reply is a file: the bytes as a `Blob` plus the headers (file name, type). A
   * non-2xx is raised as the server's error envelope. */
  async requestBlob(path: string): Promise<{ blob: Blob; headers: Headers }> {
    const res = await this.fetch(this.url(path));
    if (!res.ok) throw toApiError(res.status, await res.text());
    return { blob: await res.blob(), headers: res.headers };
  }

  /** `request`, with the 2xx reply parsed as JSON — a malformed body is a `PathApiError` too. */
  async requestJson<T>(path: string, options?: RequestOptions): Promise<T> {
    const reply = await this.request(path, options);
    return parseReply<T>(reply.status, reply.text);
  }
}

/** The `If-Match` precondition header, when the caller has an ETag to send. */
export function ifMatchHeader(ifMatch: string | undefined): Record<string, string> {
  return ifMatch === undefined ? {} : { "If-Match": ifMatch };
}

/** Parse a reply body the server promised is JSON, keeping `PathApiError` the client's only
 * failure. */
export function parseReply<T>(status: number, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PathApiError(status, `the server's reply was not valid JSON (status ${status})`);
  }
}

export function toApiError(status: number, body: string): PathApiError {
  try {
    const parsed = JSON.parse(body) as Partial<WireError>;
    if (parsed.error && typeof parsed.error.message === "string") {
      return new PathApiError(status, parsed.error.message, parsed.error.details);
    }
  } catch {
    // Non-JSON error body — fall through to a status-only message.
  }
  return new PathApiError(status, `request failed with status ${status}`);
}
