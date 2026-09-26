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

/** A non-2xx response from the server, carrying its parsed `{ error: { message, details? } }` envelope
 * (server-api-v0.md §1).
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
  /** Scope to one workflow's `id` (ADR 0015 identity, not path); a server-side filter past the latest-N window, so it
   * returns that workflow's complete history.
   */
  workflowId?: string;
}

/** The Designer edit-lock lease (ADR 0017): `session_id` is client-minted, the timestamps are server-stamped, and
 * `expires_at` is computed by the server, never trusted from the client.
 */
export type WorkflowLease = WireWorkflowLease;

/** The camelCase input to a lock acquire/takeover (`POST /v0/workflows/lock`, ADR 0017). */
export interface AcquireLockInput {
  /** The workflow's `/`-bearing relative path — the body field, not a URL segment. */
  workflowPath: string;
  sessionId: string;
  /** `true` overwrites a live marker held by another session — gate it behind an explicit user confirm. */
  takeover?: boolean;
}

/** The camelCase input to a heartbeat or a release. */
export interface LeaseOpInput {
  workflowPath: string;
  sessionId: string;
}

/** The outcome of an acquire: `held-by-other` is the `409` a **live** marker under another session takes, carrying the
 * holder's `expires_at` — a normal result here, not a `PathApiError`.
 */
export type AcquireLockResult =
  | { status: "granted"; lease: WorkflowLease }
  | { status: "held-by-other"; expiresAt: string | null };

/** The outcome of a heartbeat: `lost` is the `409` a reclaimed or taken-over marker returns, so the client stops
 * beating.
 */
export type HeartbeatResult = { status: "renewed"; lease: WorkflowLease } | { status: "lost" };

/** The camelCase input to `PUT /v0/workflows` (ADR 0016): a present `ifMatch` (the ETag of the opened bytes) makes the
 * write overwrite-only, a changed file is a `412`; absent, it is create-only.
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

/** The camelCase input to `PUT /v0/templates/:id` (server-api-v0.md §10.4): `body`'s `id` must equal `id`; the
 * required `ifMatch` is the ETag of the last read or write.
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

/** The raw read of one workflow file (`GET /v0/workflows/file`, server-api-v0.md §7.1): the exact on-disk bytes as
 * text, never the loader's parse, so the Designer keeps unknown fields and an **id-less** file it stamps on import
 * (ADR 0015).
 */
export interface WorkflowFileRaw {
  text: string;
  etag: string | null;
}

/** The camelCase, domain-shaped input to `startRun`, translated to the snake_case `StartRunRequest` body at the
 * boundary (ADR 0013); only `workflowPath` is required.
 */
export interface StartRunOptions {
  /** Path to the root workflow file, resolved against the server's fixed project root. */
  workflowPath: string;
  /** A root-context **override**: omitted means the server falls back to the file's own top-level `input` seed, then
   * `{}`.
   */
  input?: JsonValue;
  /** Operator config overrides (`RunOptions.operatorConfig`); server-validated. */
  config?: ConfigObject;
  /** The run-wide launch worker-default table (ADR 0044): `{ <type>: <name> }`, sent as the wire body's **top-level**
   * `worker_defaults`, never within `config`. Frozen with the run.
   */
  workerDefaults?: { [stepType: string]: string };
  /** Which log backends to write. Omitted: the project's settings, else `["db", "ndjson"]`. */
  logBackends?: LogBackendId[];
  /** Processor concurrency cap. Omitted: the project's settings, else the engine default. */
  processorConcurrency?: number;
}

/** A typed client over the `@path/server` v0 HTTP API (server-api-v0.md §§2–7, §10): pure TS, every request through
 * the injected `fetch`, any non-2xx raised as `PathApiError`.
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

  /** `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's `input` or `output` blob content. */
  async getBlob(rootRunId: string, runId: string, name: BlobName): Promise<JsonValue> {
    return this.requestJson<JsonValue>(
      `/v0/runs/${encodeURIComponent(rootRunId)}/blobs/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
    );
  }

  /** `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2): the `202` says the abort was signalled, not that the
   * run stopped, so learn the terminal status from the event stream.
   */
  async cancelRun(rootRunId: string): Promise<void> {
    await this.request(`/v0/runs/${encodeURIComponent(rootRunId)}/cancel`, { method: "POST" });
  }

  /** `DELETE /v0/runs/:root_run_id` — permanently remove a root run from both stores; unlike `cancelRun` this destroys
   * the audit trail, so confirm first. `force` overrides the server's live-successor guard.
   */
  async deleteRun(rootRunId: string, options: { force?: boolean } = {}): Promise<void> {
    const qs = options.force ? "?force=true" : "";
    await this.request(`/v0/runs/${encodeURIComponent(rootRunId)}${qs}`, { method: "DELETE" });
  }

  /** `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3): the only caller input is a `config` override for the
   * re-run steps — there is no `input`. `rerunFromRunId` is the Resume-from-chosen-K boundary (ADR 0032) and forces a
   * JSON body.
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

  /** `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4, ADR 0039/0040/0041): validates `output` against the
   * node's `outputSchema` before the lease, so a failure is a `400` that leaves the leaf `awaiting`. `config` may
   * re-supply a secret frozen as a `[secret:<key>]` token (ADR 0046).
   */
  async completeStep(
    stepRunId: string,
    output: JsonValue,
    config?: ConfigObject,
  ): Promise<CompleteRunResponse> {
    // Only a supplied config rides the request, so a plain Complete sends nothing extra to validate.
    const body: CompleteRunRequest = { output };
    if (config !== undefined) body.config = config;
    return this.requestJson<CompleteRunResponse>(
      `/v0/runs/${encodeURIComponent(stepRunId)}/complete`,
      { method: "POST", body },
    );
  }

  /** `POST /v0/runs` — start a run (server-api-v0.md §2). The `202` returns once the tree loads and validates;
   * translates the camelCase options inline to the snake_case wire body (ADR 0013).
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

  /** `GET /v0/workflows` — discover launchable workflows (server-api-v0.md §6, ADR 0011); a fresh scan each call,
   * `is_root`/`valid` are hints, not a launchability gate.
   */
  async listWorkflows(): Promise<ListWorkflowsResponse> {
    return this.requestJson<ListWorkflowsResponse>("/v0/workflows");
  }

  /** `GET /v0/templates` — the shipped∪user authoring-template union (server-api-v0.md §10.1, ADR 0050); a **thin**
   * list (no `body`) whose every entry carries its own `valid`/`error`, so a broken template lists rather than
   * vanishing.
   */
  async listTemplates(): Promise<ListTemplatesResponse> {
    return this.requestJson<ListTemplatesResponse>("/v0/templates");
  }

  /** `GET /v0/templates/:id` — one template as a parsed envelope (server-api-v0.md §10.2, ADR 0050); an invalid
   * template still answers `200` with `valid: false` and a best-effort `body`.
   */
  async getTemplate(id: string): Promise<GetTemplateResponse> {
    return this.requestJson<GetTemplateResponse>(`/v0/templates/${encodeURIComponent(id)}`);
  }

  /** `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050): create a **user** template under
   * `.path/template/`, the client minting the `id` inside `body`. Create-only: an existing name is a `409`.
   */
  async createTemplate(input: CreateTemplateInput): Promise<TemplateWriteResult> {
    return this.writeTemplate("/v0/templates", "POST", input, undefined);
  }

  /** `PUT /v0/templates/:id` — update a user template in place (server-api-v0.md §10.4, ADR 0050), gated on
   * `If-Match`: stale token `412`, shipped template `403`, unknown id `404`.
   */
  async putTemplate(input: PutTemplateInput): Promise<TemplateWriteResult> {
    return this.writeTemplate(
      `/v0/templates/${encodeURIComponent(input.id)}`,
      "PUT",
      input.body,
      input.ifMatch,
    );
  }

  /** `DELETE /v0/templates/:id` — delete a user template (server-api-v0.md §10.5); a shipped template is a `403`, an
   * unknown id a `404`.
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

  /** `GET /v0/step-plugins` — the step-plugin registry as data (server-api-v0.md §8): a bare snapshot with no
   * staleness contract, since the write route re-validates (ADR 0018).
   */
  async getStepPlugins(): Promise<StepPluginsResponse> {
    return this.requestJson<StepPluginsResponse>("/v0/step-plugins");
  }

  /** `GET /v0/workflows/file?path=<relative_path>` — the raw bytes of one workflow file (server-api-v0.md §7.1), text
   * rather than parsed JSON; a `404` (file gone, path escapes the root, or a symlink component) throws.
   */
  async getWorkflowFile(path: string): Promise<WorkflowFileRaw> {
    const reply = await this.request(`/v0/workflows/file?path=${encodeURIComponent(path)}`);
    return { text: reply.text, etag: reply.headers.get("ETag") };
  }

  /** `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the path rides the body (no `%2F` encoding); a present
   * `ifMatch` is the overwrite precondition, and a `412` says the file changed since it was read.
   */
  async putWorkflow(input: PutWorkflowInput): Promise<PutWorkflowResult> {
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

  /** `DELETE /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.2): the required `ifMatch` is the ETag of
   * the bytes last read or wrote, so a delete never removes unseen bytes; `sessionId` names the caller's own edit
   * lease.
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

  /** `POST /v0/workflows/lock` (ADR 0017): acquire or take over one file's edit lease; a `409` held by another live
   * session is the normal `held-by-other` result, not a throw.
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

  /** `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew the lease; a `409` (reclaimed after expiry, or taken over)
   * is the normal `lost` result, not a throw.
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

  /** `POST /v0/workflows/lock/release` (ADR 0017): idempotent, and the server deletes only when `session_id` matches,
   * so a stale beacon can never free another session's lease.
   */
  async releaseLock(input: LeaseOpInput): Promise<void> {
    const body: WireLeaseOpRequest = {
      workflow_path: input.workflowPath,
      session_id: input.sessionId,
    };
    await this.request("/v0/workflows/lock/release", { method: "POST", body });
  }

  /** The one transport: sends `method` to `path` with a JSON `body` when given, handing back the raw reply whatever
   * its status. The lock doors use it directly, because a `409` there is an ordinary answer.
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

  /** `send`, with any non-2xx raised as the server's error envelope. The reply body is not parsed: a caller that needs
   * nothing back cannot fail on an empty or non-JSON 2xx.
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
