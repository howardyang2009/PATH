import type {
  BlobName,
  ConfigObject,
  JsonValue,
  ListRunsResponse,
  ListWorkflowsResponse,
  LogBackendId,
  RunStatus,
  RunTreeResponse,
  StartRunRequest,
  StartRunResponse,
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
 * The camelCase, domain-shaped input to `startRun` — the ergonomic door the designer and mobile
 * surfaces call through, translated to the snake_case `StartRunRequest` body at the boundary
 * (ADR 0013). Only `workflowPath` is required; the rest fall back to the server's own defaults
 * (`.path/settings.json`, then built-ins). `config` passes through as authored; the server is the
 * validator (`400` on a rejected `$env` wrapper).
 */
export interface StartRunOptions {
  /** Path to the root workflow file, resolved against the server's fixed project root — the launch handle from `listWorkflows`. */
  workflowPath: string;
  /** Seeds the root run's context (`RunOptions.input`). Raw JSON — the format declares no input schema. */
  input?: JsonValue;
  /** Operator config overrides (`RunOptions.operatorConfig`); server-validated by `ConfigObjectSchema`. */
  config?: ConfigObject;
  /** Which log backends to write (`path run --log-backends`). Omitted: the project's settings, else `["db", "ndjson"]`. */
  logBackends?: LogBackendId[];
  /** Processor concurrency cap (`path run --processor-concurrency`). Omitted: the project's settings, else the engine default. */
  processorConcurrency?: number;
}

/**
 * A typed client over the `@path/server` v0 HTTP API — the read surfaces (`listRuns`/`getRun`/
 * `getBlob`/`listWorkflows`, server-api-v0.md §§3–4, §6, and the blob route) plus two actions,
 * `startRun` (§2) and `cancelRun` (§4.2). Pure TS — no framework, no DOM; every request goes through
 * the injected `fetch`, so the same client drives Node, a browser, or React Native. Reads and the
 * `startRun` reply come back as the raw snake_case wire shapes (`@path/schema`, consumed directly by
 * `RunViewModel`); only the write *input* is camelCase, translated at the boundary (ADR 0013).
 * Raises `PathApiError` for any non-2xx status.
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

  /**
   * `DELETE /v0/runs/:root_run_id` — permanently remove a root run from both stores (its `path.db`
   * rows and its blob tree). Unlike `cancelRun`, this destroys the audit trail; the caller is
   * expected to confirm first. `force` overrides the server's live-successor guard (a later run that
   * resumed from this one), mirroring `path runs rm --force`; omitted, a blocked delete arrives as a
   * `409` `PathApiError`. Other failures: `404` (unknown or already-deleted id) and `409` (the run is
   * still running — cancel it first). The `200` body only echoes the id the caller passed, so nothing
   * is read back.
   */
  async deleteRun(rootRunId: string, options: { force?: boolean } = {}): Promise<void> {
    const qs = options.force ? "?force=true" : "";
    await this.del(`/v0/runs/${encodeURIComponent(rootRunId)}${qs}`);
  }

  /**
   * `POST /v0/runs/:root_run_id/resume` — resume a `cancelled`/`failed` root run as a **successor**
   * (server-api-v0.md §4.3). The server recovers the workflow file from the predecessor's row; the
   * one thing the caller may pass is an optional `config` **override** applied to the steps that
   * re-run (there is no `input` — a resume restores its context from the predecessor). Omitting
   * `config` sends no body, unchanged from a plain resume. Async like `startRun` — the `202` carries
   * the *successor's* own `{ run_id, root_run_id }` (a fresh root run), which the caller watches from
   * here on. A `404` (unknown run, or its workflow file is gone), a `400` (invalid body, a rejected
   * `$env` config, or the workflow no longer validates), and a `409` (not resumable) arrive as
   * `PathApiError`s carrying the status and the server's message.
   */
  async resumeRun(rootRunId: string, config?: ConfigObject): Promise<StartRunResponse> {
    const path = `/v0/runs/${encodeURIComponent(rootRunId)}/resume`;
    return config === undefined
      ? this.postReadingReply<StartRunResponse>(path)
      : this.postJson<StartRunResponse>(path, { config });
  }

  /**
   * `POST /v0/runs` — start a run (server-api-v0.md §2). Async: the `202` returns as soon as the
   * workflow tree loads and validates, before execution finishes, carrying `{ run_id, root_run_id }`
   * (equal for a root run) — the caller then polls `getRun` or streams the event route. Takes the
   * camelCase `StartRunOptions` and translates it inline to the snake_case wire body (ADR 0013); the
   * reply is the raw wire `StartRunResponse`. A `400` (missing/unfound `workflow_path`, validation
   * failure, or a rejected `$env` config) and a `404` (path outside the project root) arrive as
   * `PathApiError`s.
   */
  async startRun(options: StartRunOptions): Promise<StartRunResponse> {
    const body: StartRunRequest = { workflow_path: options.workflowPath };
    if (options.input !== undefined) body.input = options.input;
    if (options.config !== undefined) body.config = options.config;
    if (options.logBackends !== undefined) body.log_backends = options.logBackends;
    if (options.processorConcurrency !== undefined) body.processor_concurrency = options.processorConcurrency;
    return this.postJson<StartRunResponse>("/v0/runs", body);
  }

  /**
   * `GET /v0/workflows` — discover launchable workflows (server-api-v0.md §6, ADR 0011). A fresh
   * scan each call (no query, no pagination): every discovered `*.workflow.json`, each flagged
   * `is_root`. `is_root`/`valid` are hints, not a launchability gate — a `valid` entry is not
   * guaranteed runnable standalone. Returns the raw wire `ListWorkflowsResponse`.
   */
  async listWorkflows(): Promise<ListWorkflowsResponse> {
    return this.getJson<ListWorkflowsResponse>("/v0/workflows");
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

  /**
   * The body-bearing, reply-parsing write — `startRun`'s transport, kept distinct from `post`
   * rather than folded in behind optional arguments, so reading either helper tells you what kind of
   * request it is without tracing a flag (the `getJson`/`post` reasoning). Sends `body` as JSON and
   * decodes the 2xx envelope, because `startRun`'s caller does not already know the `run_id` it
   * answers with — unlike `cancelRun`, whose `post` deliberately reads nothing back.
   */
  /**
   * A write that sends no request body yet *does* parse its 2xx reply — `resumeRun`'s transport,
   * distinct from `post` (reads nothing back) and `postJson` (sends a body), following the same
   * "reading the helper tells you the request shape" reasoning. Resume names its target in the path
   * but answers with the successor's ids the caller does not yet know.
   */
  private async postReadingReply<T>(path: string): Promise<T> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  /**
   * The `DELETE` sibling of `post`: same envelope decoding on a non-2xx, no request body, and the
   * 2xx reply is not parsed (`deleteRun`'s caller already knows the id). Its own helper, so reading
   * it tells you the request is a delete without tracing a method flag.
   */
  private async del(path: string): Promise<void> {
    const res = await this.fetch(this.url(path), {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    return JSON.parse(text) as T;
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
