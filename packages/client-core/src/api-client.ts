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
  StepPluginsResponse,
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
  /**
   * Scope the list to one workflow's `id` (ADR 0015 identity, not path) — the Designer's per-workflow
   * history (#365, server-api-v0.md §3). A server-side `WHERE workflow_id = ?` past the latest-N window,
   * so it composes with `limit`/`status` and returns the *complete* history for that workflow, not a
   * filtered window. An empty string is treated as omitted by the route.
   */
  workflowId?: string;
}

/**
 * The Designer edit-lock lease, server-authored (ADR 0017). `session_id` is client-minted; the three
 * timestamps are server-stamped, and `expires_at = heartbeat_at + TTL` is computed by the server, never
 * trusted from the client. The client presents only its opaque `session_id` to heartbeat, release, or
 * take over.
 */
export interface WorkflowLease {
  session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

/** The camelCase input to a lock acquire/takeover (`POST /v0/workflows/lock`, ADR 0017). */
export interface AcquireLockInput {
  /** The workflow's `/`-bearing relative path — the body field, not a URL segment (ADR 0017). */
  workflowPath: string;
  /** The client-minted UUIDv4 identifying this editing session. */
  sessionId: string;
  /** `true` overwrites a live marker held by another session — gated behind an explicit user confirm. */
  takeover?: boolean;
}

/** The camelCase input to a heartbeat or a release — the two lease ops that only renew or free. */
export interface LeaseOpInput {
  workflowPath: string;
  sessionId: string;
}

/**
 * The outcome of an acquire. `granted` carries the fresh lease; `held-by-other` is the `409` a **live**
 * marker under a different session takes — it carries the holder's `expires_at` so the UI can count down
 * and offer takeover. A `409` is a normal outcome here, not a `PathApiError`: only a `404` (a path that
 * escapes the root) and other non-2xx statuses throw.
 */
export type AcquireLockResult =
  | { status: "granted"; lease: WorkflowLease }
  | { status: "held-by-other"; expiresAt: string | null };

/**
 * The outcome of a heartbeat. `renewed` carries the extended lease; `lost` is the `409` a marker that
 * was reclaimed (expired) or taken over returns — the client stops beating and offers re-acquire.
 */
export type HeartbeatResult = { status: "renewed"; lease: WorkflowLease } | { status: "lost" };

/**
 * The camelCase input to `PUT /v0/workflows` (ADR 0016). `workflow` is the whole workflow object as
 * authored (snake_case wire, key order preserved by the server). `ifMatch` carries the ETag from the
 * opened bytes: present, the write is overwrite-only and a changed file is a `412`; absent, the write is
 * create-only (a `412` if the file already exists — there is no blind last-writer-wins).
 */
export interface PutWorkflowInput {
  workflowPath: string;
  workflow: JsonValue;
  ifMatch?: string;
}

/** The `PUT /v0/workflows` success reply (server-api-v0.md §7): the written path, its `id`, and the new ETag. */
export interface PutWorkflowResult {
  relativePath: string;
  id: string;
  etag: string;
}

/**
 * The raw read of one workflow file (`GET /v0/workflows/file`, server-api-v0.md §7.1): the exact
 * on-disk bytes as text, never the loader's parse. The Designer opens a file from this — it must keep
 * the raw body to preserve unknown fields and to receive an **id-less** file it stamps on import
 * (ADR 0015), both of which the strict loader would reject. `etag` carries the read route's strong
 * `ETag` (sha256 of the bytes), the `If-Match` source a later `PUT /v0/workflows` needs; it is `null`
 * only if a proxy stripped the header.
 */
export interface WorkflowFileRaw {
  text: string;
  etag: string | null;
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
    if (query.workflowId !== undefined) params.set("workflow_id", query.workflowId);
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

  /**
   * `GET /v0/step-plugins` — the server's step-plugin registry as data (server-api-v0.md §8), the
   * grammar the browser Designer may author. The Designer cannot scan `packages/engine/step-plugins/`,
   * so its palette and its open-time type check are registry-relative (ADR 0018): one snake_case entry
   * per registered leaf step type. A **bare snapshot with no staleness contract** — the write route
   * re-validates against the live registry, so a stale copy surfaces as a rejected write, never a
   * corrupt file. Returns the raw wire `StepPluginsResponse`.
   */
  async getStepPlugins(): Promise<StepPluginsResponse> {
    return this.getJson<StepPluginsResponse>("/v0/step-plugins");
  }

  /**
   * `GET /v0/workflows/file?path=<relative_path>` — the raw bytes of one workflow file
   * (server-api-v0.md §7.1). Unlike every other read, this returns text, not parsed JSON: the Designer
   * needs the raw body to preserve unknown fields and to open an **id-less** file it stamps on import
   * (ADR 0015), so the parse is the caller's, against its received registry. Carries the strong `ETag`
   * back for a later save's `If-Match`. A `404` (the file is gone, `path` escapes the project root, or a
   * component is a symlink) arrives as a `PathApiError`.
   */
  async getWorkflowFile(path: string): Promise<WorkflowFileRaw> {
    const res = await this.fetch(this.url(`/v0/workflows/file?path=${encodeURIComponent(path)}`), {
      headers: { Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    return { text, etag: res.headers.get("ETag") };
  }

  /**
   * `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the workflow write door. Sends the path in the
   * body (no `%2F` URL encoding) and the workflow object as authored. When `ifMatch` is given it rides
   * as the `If-Match` header, the overwrite precondition: a `412` (`PathApiError`) says the file changed
   * or vanished since it was read — the caller's stale-write conflict to resolve. A `201`/`200` reply
   * carries the written `relative_path`, the workflow `id`, and the new `etag` for the next save. A `400`
   * (validation or a duplicate id) and a `404` (path escapes the root) also arrive as `PathApiError`s.
   */
  async putWorkflow(input: PutWorkflowInput): Promise<PutWorkflowResult> {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    if (input.ifMatch !== undefined) headers["If-Match"] = input.ifMatch;
    const res = await this.fetch(this.url("/v0/workflows"), {
      method: "PUT",
      headers,
      body: JSON.stringify({ workflow_path: input.workflowPath, workflow: input.workflow }),
    });
    const text = await res.text();
    if (!res.ok) throw toApiError(res.status, text);
    const parsed = JSON.parse(text) as { relative_path: string; id: string; etag: string };
    return { relativePath: parsed.relative_path, id: parsed.id, etag: parsed.etag };
  }

  /**
   * `POST /v0/workflows/lock` (ADR 0017): acquire or take over the edit lease for one file. A `409` held
   * by another live session is a normal `held-by-other` result carrying the holder's `expires_at`, not a
   * throw — the UI counts it down and offers a confirmation-gated `takeover: true`. Only a `404` (a path
   * that escapes the project root) and other non-2xx statuses raise `PathApiError`.
   */
  async acquireLock(input: AcquireLockInput): Promise<AcquireLockResult> {
    const body: Record<string, unknown> = { workflow_path: input.workflowPath, session_id: input.sessionId };
    if (input.takeover !== undefined) body.takeover = input.takeover;
    const { status, text } = await this.postForResult("/v0/workflows/lock", body);
    if (status === 200) return { status: "granted", lease: JSON.parse(text) as WorkflowLease };
    if (status === 409) {
      const parsed = JSON.parse(text) as { expires_at?: string };
      return { status: "held-by-other", expiresAt: parsed.expires_at ?? null };
    }
    throw toApiError(status, text);
  }

  /**
   * `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew the lease. A `409` (the marker was reclaimed
   * after expiry, or taken over by another session) is a normal `lost` result, not a throw: the caller
   * stops beating and warns "editing lease lost" with a re-acquire affordance. Other non-2xx throw.
   */
  async heartbeatLock(input: LeaseOpInput): Promise<HeartbeatResult> {
    const body = { workflow_path: input.workflowPath, session_id: input.sessionId };
    const { status, text } = await this.postForResult("/v0/workflows/lock/heartbeat", body);
    if (status === 200) return { status: "renewed", lease: JSON.parse(text) as WorkflowLease };
    if (status === 409) return { status: "lost" };
    throw toApiError(status, text);
  }

  /**
   * `POST /v0/workflows/lock/release` (ADR 0017): free the lease. Idempotent (`200` even when the marker
   * is already gone); the server deletes it only when `session_id` matches, so a stale beacon can never
   * free another session's lease. This is the `fetch`-driven release for an in-app close; a tab unload
   * uses `navigator.sendBeacon` against `url("/v0/workflows/lock/release")` instead, which is POST-only.
   */
  async releaseLock(input: LeaseOpInput): Promise<void> {
    const body = { workflow_path: input.workflowPath, session_id: input.sessionId };
    const { status, text } = await this.postForResult("/v0/workflows/lock/release", body);
    if (status < 200 || status >= 300) throw toApiError(status, text);
  }

  /**
   * A JSON POST whose non-2xx is *not* automatically a throw — the caller decides which statuses are
   * normal outcomes (a lock `409`) and which are errors. Returns the raw status and body text; the lock
   * methods branch on it, and every unexpected status still routes through `toApiError`. All three lock
   * routes are POST (ADR 0017), so the verb is fixed rather than a flag — the same "reading the helper
   * tells you the request shape" stance `post`/`postJson` take.
   */
  private async postForResult(path: string, body: unknown): Promise<{ status: number; text: string }> {
    const res = await this.fetch(this.url(path), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
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
