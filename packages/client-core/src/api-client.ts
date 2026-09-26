import type {
  BlobName,
  CompleteRunRequest,
  CompleteRunResponse,
  ConfigObject,
  GetTemplateResponse,
  JsonValue,
  ListRunsResponse,
  ListTemplatesResponse,
  ListWorkflowsResponse,
  LogBackendId,
  RunStatus,
  RunTreeResponse,
  StartRunRequest,
  StartRunResponse,
  StepPluginsResponse,
  WireError,
  WireLeaseOpRequest,
  WireLockHeldBody,
  WireLockRequest,
  WirePostTemplateRequest,
  WirePutWorkflowRequest,
  WirePutWorkflowResponse,
  WireTemplateWriteResponse,
  WireWorkflowLease,
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
 *
 * The shape itself is `@path/schema`'s `WireWorkflowLease` — the very interface the server authors it
 * from — so a rename on either side is a compile error rather than a browser reading `undefined`.
 */
export type WorkflowLease = WireWorkflowLease;

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

/** The camelCase input to `POST /v0/templates` (server-api-v0.md §10.3): the save-as envelope. */
export type CreateTemplateInput = WirePostTemplateRequest;

/**
 * The camelCase input to `PUT /v0/templates/:id` (server-api-v0.md §10.4). `body` is the full template
 * object, whose `id` must equal `id`; `ifMatch` is the ETag of the last read or write, and is required.
 */
export interface PutTemplateInput {
  id: string;
  body: JsonValue;
  ifMatch: string;
}

/** A template write's reply (server-api-v0.md §10.3, §10.4): the template id, its path, and the new ETag. */
export interface TemplateWriteResult {
  id: string;
  relativePath: string;
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
  /**
   * Seeds the root run's context (`RunOptions.input`). An **override**: omitted (or an empty object)
   * means the server falls back to the workflow file's own top-level `input` seed, then to `{}`. Raw
   * JSON — the format declares no input schema.
   */
  input?: JsonValue;
  /** Operator config overrides (`RunOptions.operatorConfig`); server-validated by `ConfigObjectSchema`. */
  config?: ConfigObject;
  /**
   * The run-wide **launch worker-default** table (ADR 0044, #517): `{ <type>: <name> }`, the ergonomic
   * peer of the CLI's repeatable `--worker-default`. Encoded to the wire body's top-level
   * `worker_defaults` — beside `input`/`config`, never within `config` — so an HTTP launch resolves
   * un-pinned steps exactly as a CLI launch. Frozen with the run, so `resumeRun` takes none.
   */
  workerDefaults?: { [stepType: string]: string };
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
    return this.requestJson<ListRunsResponse>(`/v0/runs${qs ? `?${qs}` : ""}`);
  }

  /** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
  async getRun(rootRunId: string): Promise<RunTreeResponse> {
    return this.requestJson<RunTreeResponse>(`/v0/runs/${encodeURIComponent(rootRunId)}`);
  }

  /**
   * `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's `input` or `output` blob content.
   * The route lands server-side in its own ticket; the client is written to the agreed contract.
   */
  async getBlob(rootRunId: string, runId: string, name: BlobName): Promise<JsonValue> {
    return this.requestJson<JsonValue>(
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
    await this.request(`/v0/runs/${encodeURIComponent(rootRunId)}/cancel`, { method: "POST" });
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
    await this.request(`/v0/runs/${encodeURIComponent(rootRunId)}${qs}`, { method: "DELETE" });
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
   *
   * `rerunFromRunId` is the **Resume-from-chosen-K** boundary (#444, ADR 0032): the source run id of
   * the node the operator picked as K. Omitted, this is plain Resume (the auto-boundary case); present,
   * it rides the body as `rerun_from_run_id` and the engine's one legal-K authority validates it,
   * refusing an illegal pick with the taxonomy status + message. It sends a body even when `config` is
   * omitted, so a K with no config override is still a JSON request, not the no-body plain resume.
   */
  async resumeRun(
    rootRunId: string,
    config?: ConfigObject,
    rerunFromRunId?: string,
  ): Promise<StartRunResponse> {
    const path = `/v0/runs/${encodeURIComponent(rootRunId)}/resume`;
    const body: { config?: ConfigObject; rerun_from_run_id?: string } = {};
    if (config !== undefined) body.config = config;
    if (rerunFromRunId !== undefined) body.rerun_from_run_id = rerunFromRunId;
    return Object.keys(body).length === 0
      ? this.requestJson<StartRunResponse>(path, { method: "POST" })
      : this.requestJson<StartRunResponse>(path, { method: "POST", body });
  }

  /**
   * `POST /v0/runs/:step_run_id/complete` — resolve a parked `awaiting` leaf with a person's `output`
   * (server-api-v0.md §4.4, ADR 0039/0040/0041). The path names the **leaf**; the server derives its
   * tree's root. Validation runs before the lease, so an `output` that fails the node's `outputSchema`
   * is a `400` carrying the ajv issues in `error.details` (`PathApiError.details`) and leaves the leaf
   * `awaiting` for a corrected resubmit. On success the `202` carries `{ step_run_id, root_run_id }`;
   * the run continues in the background and the caller learns the outcome from the root's SSE stream it
   * is already watching. A `404` (unknown id / file gone) and a `409` (not-`awaiting`, lease held, or a
   * node the author retyped mid-wait) also arrive as `PathApiError`s carrying the status and message.
   *
   * `config` is the optional override a continuation may re-supply (ADR 0046): a Complete **recovers**
   * the launch's frozen config, and a value frozen as its `[secret:<key>]` token cannot continue the
   * run — the engine refuses before its first step until the operator enters it again. Omitted, the
   * body is `{ output }` alone, byte-identical to before.
   */
  async completeStep(
    stepRunId: string,
    output: JsonValue,
    config?: ConfigObject,
  ): Promise<CompleteRunResponse> {
    // Same optional-body handling as `resumeRun`: only a supplied config rides the request, so a plain
    // Complete sends nothing extra for the server to validate. The body is the shared wire type, so its
    // field set cannot drift from the one the route decodes.
    const body: CompleteRunRequest = { output };
    if (config !== undefined) body.config = config;
    return this.requestJson<CompleteRunResponse>(
      `/v0/runs/${encodeURIComponent(stepRunId)}/complete`,
      { method: "POST", body },
    );
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
    if (options.workerDefaults !== undefined) body.worker_defaults = options.workerDefaults;
    if (options.logBackends !== undefined) body.log_backends = options.logBackends;
    if (options.processorConcurrency !== undefined)
      body.processor_concurrency = options.processorConcurrency;
    return this.requestJson<StartRunResponse>("/v0/runs", { method: "POST", body });
  }

  /**
   * `GET /v0/workflows` — discover launchable workflows (server-api-v0.md §6, ADR 0011). A fresh
   * scan each call (no query, no pagination): every discovered `*.workflow.json`, each flagged
   * `is_root`. `is_root`/`valid` are hints, not a launchability gate — a `valid` entry is not
   * guaranteed runnable standalone. Returns the raw wire `ListWorkflowsResponse`.
   */
  async listWorkflows(): Promise<ListWorkflowsResponse> {
    return this.requestJson<ListWorkflowsResponse>("/v0/workflows");
  }

  /**
   * `GET /v0/templates` — the shipped∪user authoring-template union (server-api-v0.md §10.1, ADR 0050).
   * A fresh scan each call; the list is **thin** (no `body`) and every entry carries its
   * registry-relative `valid`/`error`, so a broken template lists rather than vanishing. Both kinds;
   * the palette splits them by `kind`. Returns the raw wire `ListTemplatesResponse`.
   */
  async listTemplates(): Promise<ListTemplatesResponse> {
    return this.requestJson<ListTemplatesResponse>("/v0/templates");
  }

  /**
   * `GET /v0/templates/:id` — one template as a parsed envelope (server-api-v0.md §10.2, ADR 0050),
   * body included. An invalid template still answers `200` with `valid: false` and its best-effort
   * `body`, so the caller decides whether to use it; an unknown id arrives as a `404` `PathApiError`.
   */
  async getTemplate(id: string): Promise<GetTemplateResponse> {
    return this.requestJson<GetTemplateResponse>(`/v0/templates/${encodeURIComponent(id)}`);
  }

  /**
   * `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050 decision 6): create a **user**
   * template under `.path/template/`. The client mints the `id` inside `body` (ADR 0015). Create-only: a
   * name that already exists is a `409` `PathApiError`; a bad `name` or body is a `400`.
   */
  async createTemplate(input: CreateTemplateInput): Promise<TemplateWriteResult> {
    return this.writeTemplate("/v0/templates", "POST", input, undefined);
  }

  /**
   * `PUT /v0/templates/:id` — update a user template in place (server-api-v0.md §10.4, ADR 0050
   * decision 7), gated on `If-Match`. A stale token is a `412`, a shipped (read-only) template a `403`,
   * and an unknown id a `404`, each as a `PathApiError`.
   */
  async putTemplate(input: PutTemplateInput): Promise<TemplateWriteResult> {
    return this.writeTemplate(
      `/v0/templates/${encodeURIComponent(input.id)}`,
      "PUT",
      input.body,
      input.ifMatch,
    );
  }

  /**
   * `DELETE /v0/templates/:id` — delete a user template (server-api-v0.md §10.5). A shipped (read-only)
   * template is a `403` and an unknown id a `404`, each as a `PathApiError`.
   */
  async deleteTemplate(id: string): Promise<void> {
    await this.request(`/v0/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** The one transport behind both template writes: a JSON body, an optional `If-Match`, a parsed reply. */
  private async writeTemplate(
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    ifMatch: string | undefined,
  ): Promise<TemplateWriteResult> {
    const reply = await this.requestJson<WireTemplateWriteResponse>(path, {
      method,
      body,
      headers: ifMatchHeader(ifMatch),
    });
    return { id: reply.id, relativePath: reply.relative_path, etag: reply.etag };
  }

  /**
   * `GET /v0/step-plugins` — the server's step-plugin registry as data (server-api-v0.md §8), the
   * grammar the browser Designer may author. The Designer cannot scan `packages/engine/plugin/step-plugin/`,
   * so its palette and its open-time type check are registry-relative (ADR 0018): one snake_case entry
   * per registered leaf step type. A **bare snapshot with no staleness contract** — the write route
   * re-validates against the live registry, so a stale copy surfaces as a rejected write, never a
   * corrupt file. Returns the raw wire `StepPluginsResponse`.
   */
  async getStepPlugins(): Promise<StepPluginsResponse> {
    return this.requestJson<StepPluginsResponse>("/v0/step-plugins");
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
    const reply = await this.request(`/v0/workflows/file?path=${encodeURIComponent(path)}`);
    return { text: reply.text, etag: reply.headers.get("ETag") };
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
    // The camelCase input is renamed inline to the shared wire shape (ADR 0013): one declaration, so a
    // field the server stops reading is a compile error here rather than a silently dropped write.
    const body: WirePutWorkflowRequest = {
      workflow_path: input.workflowPath,
      workflow: input.workflow as WirePutWorkflowRequest["workflow"],
    };
    const reply = await this.requestJson<WirePutWorkflowResponse>("/v0/workflows", {
      method: "PUT",
      body,
      headers: ifMatchHeader(input.ifMatch),
    });
    return { relativePath: reply.relative_path, id: reply.id, etag: reply.etag };
  }

  /**
   * `DELETE /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.2): delete one workflow file.
   * `ifMatch` is required, the ETag of the bytes the caller last read or wrote, so a delete never removes
   * bytes the caller has not seen: a `412` says the file changed. `sessionId` names the caller's own edit
   * lease, which the delete removes with the file; another session's live lease is a `409`. A `404` (the
   * file is gone or the path escapes the root) and a `400` (a template path) also arrive as `PathApiError`s.
   */
  async deleteWorkflowFile(input: {
    path: string;
    ifMatch: string;
    sessionId?: string;
  }): Promise<void> {
    const query = new URLSearchParams({ path: input.path });
    if (input.sessionId !== undefined) query.set("session_id", input.sessionId);
    await this.request(`/v0/workflows/file?${query.toString()}`, {
      method: "DELETE",
      headers: { "If-Match": input.ifMatch },
    });
  }

  /**
   * `POST /v0/workflows/lock` (ADR 0017): acquire or take over the edit lease for one file. A `409` held
   * by another live session is a normal `held-by-other` result carrying the holder's `expires_at`, not a
   * throw — the UI counts it down and offers a confirmation-gated `takeover: true`. Only a `404` (a path
   * that escapes the project root) and other non-2xx statuses raise `PathApiError`.
   */
  async acquireLock(input: AcquireLockInput): Promise<AcquireLockResult> {
    const body: WireLockRequest = {
      workflow_path: input.workflowPath,
      session_id: input.sessionId,
    };
    if (input.takeover !== undefined) body.takeover = input.takeover;
    const { status, text } = await this.send("/v0/workflows/lock", { method: "POST", body });
    if (status === 200)
      return { status: "granted", lease: parseReply<WorkflowLease>(status, text) };
    if (status === 409)
      return {
        status: "held-by-other",
        expiresAt: parseReply<WireLockHeldBody>(status, text).expires_at ?? null,
      };
    throw toApiError(status, text);
  }

  /**
   * `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew the lease. A `409` (the marker was reclaimed
   * after expiry, or taken over by another session) is a normal `lost` result, not a throw: the caller
   * stops beating and warns "editing lease lost" with a re-acquire affordance. Other non-2xx throw.
   */
  async heartbeatLock(input: LeaseOpInput): Promise<HeartbeatResult> {
    const body: WireLeaseOpRequest = {
      workflow_path: input.workflowPath,
      session_id: input.sessionId,
    };
    const { status, text } = await this.send("/v0/workflows/lock/heartbeat", {
      method: "POST",
      body,
    });
    if (status === 200)
      return { status: "renewed", lease: parseReply<WorkflowLease>(status, text) };
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
    const body: WireLeaseOpRequest = {
      workflow_path: input.workflowPath,
      session_id: input.sessionId,
    };
    await this.request("/v0/workflows/lock/release", { method: "POST", body });
  }

  /**
   * The one transport. Sends `method` to `path` — a JSON `body` when given, plus any extra `headers` —
   * and hands back the raw reply whatever its status. The lock doors use it directly, because a `409`
   * there is an ordinary answer; every other caller goes through `request`.
   */
  private async send(path: string, options: RequestOptions = {}): Promise<Reply> {
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

  /**
   * `send`, with any non-2xx raised as the server's error envelope (`PathApiError`). The reply body is
   * not parsed: a caller that already knows everything the reply would say reads nothing back, so an
   * empty or non-JSON 2xx cannot fail it.
   */
  private async request(path: string, options?: RequestOptions): Promise<Reply> {
    const reply = await this.send(path, options);
    if (reply.status < 200 || reply.status >= 300) throw toApiError(reply.status, reply.text);
    return reply;
  }

  /** `request`, with the 2xx reply parsed as JSON — a malformed body is a `PathApiError` too. */
  private async requestJson<T>(path: string, options?: RequestOptions): Promise<T> {
    const reply = await this.request(path, options);
    return parseReply<T>(reply.status, reply.text);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent as JSON, with a `Content-Type` to say so. */
  body?: unknown;
  headers?: Record<string, string>;
}

interface Reply {
  status: number;
  text: string;
  headers: Headers;
}

/** The `If-Match` precondition header, when the caller has an ETag to send. */
function ifMatchHeader(ifMatch: string | undefined): Record<string, string> {
  return ifMatch === undefined ? {} : { "If-Match": ifMatch };
}

/** Parse a reply body the server promised is JSON, keeping `PathApiError` the client's only failure. */
function parseReply<T>(status: number, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PathApiError(status, `the server's reply was not valid JSON (status ${status})`);
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
