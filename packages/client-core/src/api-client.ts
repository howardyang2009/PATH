import type {
  BlobName,
  JsonValue,
  ListRunsResponse,
  RunStatus,
  RunTreeResponse,
  WireError,
} from "@path/schema";

/** A minimal `fetch` shape — injectable so browser/React Native/tests can supply their own. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The default transport: the ambient global `fetch`, wrapped rather than passed by reference. */
export const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface PathApiClientOptions {
  /** Base URL of a running `path-server`, e.g. `http://localhost:8080`. Trailing slash trimmed. */
  baseUrl: string;
  /** Injected `fetch`; defaults to the global. Lets a host swap in its own transport. */
  fetch?: FetchLike;
}

/**
 * A non-2xx response from the server, carrying the parsed `{ error: { message, details? } }`
 * envelope (server-api-v0.md §1) where present.
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

export interface ListRunsQuery {
  limit?: number;
  status?: RunStatus;
}

/**
 * A typed client over the `@path/server` v0 HTTP API — the read surfaces (server-api-v0.md §§3–4
 * and the blob route) plus one action, `cancelRun` (§4.2). Pure TS — no framework, no DOM; every
 * request goes through the injected `fetch`, so the same client drives Node, a browser, or React
 * Native. Decodes the snake_case wire shapes into `./wire-types`, and raises `PathApiError` for any
 * non-2xx status.
 */
export class PathApiClient {
  /** The normalized base URL (trailing slash trimmed). */
  readonly baseUrl: string;
  /** The resolved transport — exposed so the SSE client/connector reuse the same `fetch`. */
  readonly fetch: FetchLike;

  constructor(options: PathApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? defaultFetch;
  }

  /** The base URL joined to a v0 path — exposed so the SSE client can build the events URL. */
  url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** `GET /v0/runs` — list root runs, most recent first (server-api-v0.md §3). */
  async listRuns(query: ListRunsQuery = {}): Promise<ListRunsResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.status !== undefined) params.set("status", query.status);
    const qs = params.toString();
    return this.getJson<ListRunsResponse>(`/v0/runs${qs ? `?${qs}` : ""}`);
  }

  /** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
  async getRun(rootRunId: string): Promise<RunTreeResponse> {
    return this.getJson<RunTreeResponse>(`/v0/runs/${encodeURIComponent(rootRunId)}`);
  }

  /**
   * `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's `input` or `output` blob content.
   * The route lands server-side in its own ticket; the client is written to the agreed contract.
   */
  async getBlob(rootRunId: string, runId: string, name: BlobName): Promise<JsonValue> {
    return this.getJson<JsonValue>(
      `/v0/runs/${encodeURIComponent(rootRunId)}/blobs/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
    );
  }

  /**
   * `POST /v0/runs/:root_run_id/cancel` — signal the abort of a root run in flight
   * (server-api-v0.md §4.2). Best-effort and asynchronous: the 202 says the abort was signalled,
   * not that the run has stopped, so the caller learns the terminal status from the event stream it
   * is already watching. The 202 body is `{ root_run_id }`, which the caller passed in, so there is
   * nothing to hand back. A 404 (unknown run) and a 409 (already terminal, or not executing in this
   * server process) arrive as `PathApiError`s carrying that status and the server's message.
   */
  async cancelRun(rootRunId: string): Promise<void> {
    await this.post(`/v0/runs/${encodeURIComponent(rootRunId)}/cancel`);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetch(this.url(path), { headers: { Accept: "application/json" } });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  /**
   * The write sibling of `getJson`: same `toApiError` envelope decoding on a non-2xx, no request
   * body — no v0 action takes one. Kept as its own helper rather than a `method` argument on
   * `getJson`, so reading either one tells you what kind of request it is without tracing a flag.
   *
   * The success body is *not* parsed. No v0 action answers with anything its caller does not
   * already know, so parsing would only add a way to fail: an empty or non-JSON 2xx — a proxy
   * stripping a body, a future `204` — would raise a bare `SyntaxError` rather than the
   * `PathApiError` this class promises is its only failure.
   */
  private async post(path: string): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
  }
}

function toApiError(status: number, body: string): PathApiError {
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
