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
  WireCopyWorkflowResponse,
  WireLeaseOpRequest,
  WireLockHeldBody,
  WireLockRequest,
  WirePostTemplateRequest,
  WirePutSecretRequest,
  WirePutWorkflowRequest,
  WirePutWorkflowResponse,
  WireSecretList,
  WireSecretSummary,
  WireTemplateWriteResponse,
  WireWorkflowLease,
} from "@path/schema";
import {
  authorizedFetch,
  defaultFetch,
  type FetchLike,
  HttpTransport,
  ifMatchHeader,
  parseReply,
  type RequestAuth,
  toApiError,
  trimBaseUrl,
} from "./transport.js";

export { defaultFetch, type FetchLike, PathApiError } from "./transport.js";

// The v0 API client, in one module: `PathApiClient` is the interface a surface holds, and the
// endpoint functions below are its implementation. They live here rather than in per-group files
// because a group function has exactly one caller — the class method over it — so a separate module
// would be a seam nobody crosses (ADR 0093). `./transport.js` is the injectable `fetch` seam
// beneath both.

// ── Runs ──────────────────────────────────────────────────────────────────────────

export interface ListRunsQuery {
  limit?: number;
  status?: RunStatus;
  /** Scope to one workflow's `id` (ADR 0015 identity, not path); a server-side filter past the
   * latest-N window, so it returns that workflow's complete history.
   */
  workflowId?: string;
}

/** The camelCase, domain-shaped input to `startRun`, translated to the snake_case `StartRunRequest`
 * body at the boundary (ADR 0013); only `workflowPath` is required.
 */
export interface StartRunOptions {
  /** Path to the root workflow file, resolved against the server's fixed project root. */
  workflowPath: string;
  /** A root-context **override**: omitted means the server falls back to the file's own top-level
   * `input` seed, then `{}`.
   */
  input?: JsonValue;
  /** Operator config overrides (`RunOptions.operatorConfig`); server-validated. */
  config?: ConfigObject;
  /** The run-wide launch worker-default table (ADR 0044): `{ <type>: <name> }`, sent as the wire
   * body's **top-level** `worker_defaults`, never within `config`. Frozen with the run.
   */
  workerDefaults?: { [stepType: string]: string };
  /** Which log backends to write. Omitted: the project's settings, else `["db", "ndjson"]`. */
  logBackends?: LogBackendId[];
  /** Processor concurrency cap. Omitted: the project's settings, else the engine default. */
  processorConcurrency?: number;
}

function listRuns(http: HttpTransport, query: ListRunsQuery): Promise<ListRunsResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.status !== undefined) params.set("status", query.status);
  if (query.workflowId !== undefined) params.set("workflow_id", query.workflowId);
  const qs = params.toString();
  return http.requestJson<ListRunsResponse>(`/v0/runs${qs ? `?${qs}` : ""}`);
}

function getRun(http: HttpTransport, rootRunId: string): Promise<RunTreeResponse> {
  return http.requestJson<RunTreeResponse>(`/v0/runs/${encodeURIComponent(rootRunId)}`);
}

function getBlob(
  http: HttpTransport,
  rootRunId: string,
  runId: string,
  name: BlobName,
): Promise<JsonValue> {
  return http.requestJson<JsonValue>(
    `/v0/runs/${encodeURIComponent(rootRunId)}/blobs/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
  );
}

async function cancelRun(http: HttpTransport, rootRunId: string): Promise<void> {
  await http.request(`/v0/runs/${encodeURIComponent(rootRunId)}/cancel`, { method: "POST" });
}

async function deleteRun(
  http: HttpTransport,
  rootRunId: string,
  options: { force?: boolean },
): Promise<void> {
  const qs = options.force ? "?force=true" : "";
  await http.request(`/v0/runs/${encodeURIComponent(rootRunId)}${qs}`, { method: "DELETE" });
}

function resumeRun(
  http: HttpTransport,
  rootRunId: string,
  config?: ConfigObject,
  rerunFromRunId?: string,
): Promise<StartRunResponse> {
  const path = `/v0/runs/${encodeURIComponent(rootRunId)}/resume`;
  const body: { config?: ConfigObject; rerun_from_run_id?: string } = {};
  if (config !== undefined) body.config = config;
  if (rerunFromRunId !== undefined) body.rerun_from_run_id = rerunFromRunId;
  return Object.keys(body).length === 0
    ? http.requestJson<StartRunResponse>(path, { method: "POST" })
    : http.requestJson<StartRunResponse>(path, { method: "POST", body });
}

function completeStep(
  http: HttpTransport,
  stepRunId: string,
  output: JsonValue,
  config?: ConfigObject,
): Promise<CompleteRunResponse> {
  // Only a supplied config rides the request, so a plain Complete sends nothing extra to validate.
  const body: CompleteRunRequest = { output };
  if (config !== undefined) body.config = config;
  return http.requestJson<CompleteRunResponse>(
    `/v0/runs/${encodeURIComponent(stepRunId)}/complete`,
    { method: "POST", body },
  );
}

function startRun(http: HttpTransport, options: StartRunOptions): Promise<StartRunResponse> {
  const body: StartRunRequest = { workflow_path: options.workflowPath };
  if (options.input !== undefined) body.input = options.input;
  if (options.config !== undefined) body.config = options.config;
  if (options.workerDefaults !== undefined) body.worker_defaults = options.workerDefaults;
  if (options.logBackends !== undefined) body.log_backends = options.logBackends;
  if (options.processorConcurrency !== undefined)
    body.processor_concurrency = options.processorConcurrency;
  return http.requestJson<StartRunResponse>("/v0/runs", { method: "POST", body });
}

// ── Workflows ──────────────────────────────────────────────────────────────────────────

/** The camelCase input to `PUT /v0/workflows` (ADR 0016): a present `ifMatch` (the ETag of the
 * opened bytes) makes the write overwrite-only, a changed file is a `412`; absent, it is
 * create-only.
 */
export interface PutWorkflowInput {
  workflowPath: string;
  workflow: JsonValue;
  ifMatch?: string;
}

/** The `PUT /v0/workflows` success reply (server-api-v0.md §7): the written path, its `id`, and the
 * new ETag. */
export interface PutWorkflowResult {
  relativePath: string;
  id: string;
  etag: string;
}

/** The raw read of one workflow file (`GET /v0/workflows/file`, server-api-v0.md §7.1): the exact
 * on-disk bytes as text, never the loader's parse, so the Designer keeps unknown fields and an
 * **id-less** file it stamps on import (ADR 0015).
 */
export interface WorkflowFileRaw {
  text: string;
  etag: string | null;
}

function listWorkflows(http: HttpTransport): Promise<ListWorkflowsResponse> {
  return http.requestJson<ListWorkflowsResponse>("/v0/workflows");
}

/** `POST /v0/workflows/copy` (server-api-v0.md §7.3, ADR 0086): copy a shipped workflow into the
 * user's own folder; the reply names the copy's project-relative path. */
async function copyShippedWorkflow(
  http: HttpTransport,
  shippedPath: string,
): Promise<{ relativePath: string; rootPath: string }> {
  const reply = await http.requestJson<WireCopyWorkflowResponse>("/v0/workflows/copy", {
    method: "POST",
    body: { shipped_path: shippedPath },
  });
  return { relativePath: reply.relative_path, rootPath: reply.root_path };
}

/** A file the server sent for saving: its name from `Content-Disposition`, and its bytes. */
export interface DownloadedFile {
  fileName: string;
  blob: Blob;
}

function fileNameOf(headers: Headers, fallback: string): string {
  const disposition = headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) return decodeURIComponent(encoded);
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? fallback;
}

/** `GET /v0/workflows/download` (server-api-v0.md §7.4): the saved workflow file, or a zip of its
 * `ref` closure. An unresolvable `ref` is a `422` whose `details` lists each one. */
async function downloadWorkflow(http: HttpTransport, path: string): Promise<DownloadedFile> {
  const { blob, headers } = await http.requestBlob(
    `/v0/workflows/download?path=${encodeURIComponent(path)}`,
  );
  return { fileName: fileNameOf(headers, "workflow.json"), blob };
}

/** `GET /v0/templates/:id/download` (server-api-v0.md §10.6): the template's file. */
async function downloadTemplate(http: HttpTransport, id: string): Promise<DownloadedFile> {
  const { blob, headers } = await http.requestBlob(
    `/v0/templates/${encodeURIComponent(id)}/download`,
  );
  return { fileName: fileNameOf(headers, "template.step-template.json"), blob };
}

function getStepPlugins(http: HttpTransport): Promise<StepPluginsResponse> {
  return http.requestJson<StepPluginsResponse>("/v0/step-plugins");
}

async function getWorkflowFile(http: HttpTransport, path: string): Promise<WorkflowFileRaw> {
  const reply = await http.request(`/v0/workflows/file?path=${encodeURIComponent(path)}`);
  return { text: reply.text, etag: reply.headers.get("ETag") };
}

async function putWorkflow(
  http: HttpTransport,
  input: PutWorkflowInput,
): Promise<PutWorkflowResult> {
  const body: WirePutWorkflowRequest = {
    workflow_path: input.workflowPath,
    workflow: input.workflow as WirePutWorkflowRequest["workflow"],
  };
  const reply = await http.requestJson<WirePutWorkflowResponse>("/v0/workflows", {
    method: "PUT",
    body,
    headers: ifMatchHeader(input.ifMatch),
  });
  return { relativePath: reply.relative_path, id: reply.id, etag: reply.etag };
}

/** What a workflow-file delete names: the path, its required `If-Match`, and the caller's own edit
 * lease. */
export interface DeleteWorkflowInput {
  path: string;
  ifMatch: string;
  sessionId?: string;
}

async function deleteWorkflowFile(http: HttpTransport, input: DeleteWorkflowInput): Promise<void> {
  const query = new URLSearchParams({ path: input.path });
  if (input.sessionId !== undefined) query.set("session_id", input.sessionId);
  await http.request(`/v0/workflows/file?${query.toString()}`, {
    method: "DELETE",
    headers: { "If-Match": input.ifMatch },
  });
}

// ── Templates ──────────────────────────────────────────────────────────────────────────

/** The camelCase input to `POST /v0/templates` (server-api-v0.md §10.3): the save-as envelope. */
export type CreateTemplateInput = WirePostTemplateRequest;

/** The camelCase input to `PUT /v0/templates/:id` (server-api-v0.md §10.4): `body`'s `id` must
 * equal `id`; the required `ifMatch` is the ETag of the last read or write.
 */
export interface PutTemplateInput {
  id: string;
  body: JsonValue;
  ifMatch: string;
}

/** A template write's reply (server-api-v0.md §10.3, §10.4): the template id, its path, and the new
 * ETag. */
export interface TemplateWriteResult {
  id: string;
  relativePath: string;
  etag: string;
}

function listTemplates(http: HttpTransport): Promise<ListTemplatesResponse> {
  return http.requestJson<ListTemplatesResponse>("/v0/templates");
}

function getTemplate(http: HttpTransport, id: string): Promise<GetTemplateResponse> {
  return http.requestJson<GetTemplateResponse>(`/v0/templates/${encodeURIComponent(id)}`);
}

function createTemplate(
  http: HttpTransport,
  input: CreateTemplateInput,
): Promise<TemplateWriteResult> {
  return writeTemplate(http, "/v0/templates", "POST", input, undefined);
}

function putTemplate(http: HttpTransport, input: PutTemplateInput): Promise<TemplateWriteResult> {
  return writeTemplate(
    http,
    `/v0/templates/${encodeURIComponent(input.id)}`,
    "PUT",
    input.body,
    input.ifMatch,
  );
}

async function deleteTemplate(http: HttpTransport, id: string): Promise<void> {
  await http.request(`/v0/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The one transport behind both template writes: a JSON body, an optional `If-Match`, a parsed
 * reply. */
async function writeTemplate(
  http: HttpTransport,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  ifMatch: string | undefined,
): Promise<TemplateWriteResult> {
  const reply = await http.requestJson<WireTemplateWriteResponse>(path, {
    method,
    body,
    headers: ifMatchHeader(ifMatch),
  });
  return { id: reply.id, relativePath: reply.relative_path, etag: reply.etag };
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────

async function listSecrets(http: HttpTransport): Promise<WireSecretSummary[]> {
  return (await http.requestJson<WireSecretList>("/v0/secrets")).secrets;
}

function putSecret(http: HttpTransport, name: string, value: string): Promise<WireSecretSummary> {
  const body: WirePutSecretRequest = { value };
  return http.requestJson<WireSecretSummary>(`/v0/secrets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body,
  });
}

async function deleteSecret(http: HttpTransport, name: string): Promise<void> {
  await http.request(`/v0/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
}

// ── Leases ──────────────────────────────────────────────────────────────────────────

/** The Designer edit-lock lease (ADR 0017): `session_id` is client-minted, the timestamps are
 * server-stamped, and `expires_at` is computed by the server, never trusted from the client.
 */
export type WorkflowLease = WireWorkflowLease;

/** The camelCase input to a lock acquire/takeover (`POST /v0/workflows/lock`, ADR 0017). */
export interface AcquireLockInput {
  /** The workflow's `/`-bearing relative path — the body field, not a URL segment. */
  workflowPath: string;
  sessionId: string;
  /** `true` overwrites a live marker held by another session — gate it behind an explicit user
   * confirm. */
  takeover?: boolean;
}

/** The camelCase input to a heartbeat or a release. */
export interface LeaseOpInput {
  workflowPath: string;
  sessionId: string;
}

/** The outcome of an acquire: `held-by-other` is the `409` a **live** marker under another session
 * takes, carrying the holder's `expires_at` — a normal result here, not a `PathApiError`.
 */
export type AcquireLockResult =
  | { status: "granted"; lease: WorkflowLease }
  | { status: "held-by-other"; expiresAt: string | null };

/** The outcome of a heartbeat: `lost` is the `409` a reclaimed or taken-over marker returns, so the
 * client stops beating.
 */
export type HeartbeatResult = { status: "renewed"; lease: WorkflowLease } | { status: "lost" };

async function acquireLock(
  http: HttpTransport,
  input: AcquireLockInput,
): Promise<AcquireLockResult> {
  const body: WireLockRequest = {
    workflow_path: input.workflowPath,
    session_id: input.sessionId,
  };
  if (input.takeover !== undefined) body.takeover = input.takeover;
  const { status, text } = await http.send("/v0/workflows/lock", { method: "POST", body });
  if (status === 200) return { status: "granted", lease: parseReply<WorkflowLease>(status, text) };
  if (status === 409)
    return {
      status: "held-by-other",
      expiresAt: parseReply<WireLockHeldBody>(status, text).expires_at ?? null,
    };
  throw toApiError(status, text);
}

async function heartbeatLock(http: HttpTransport, input: LeaseOpInput): Promise<HeartbeatResult> {
  const { status, text } = await http.send("/v0/workflows/lock/heartbeat", {
    method: "POST",
    body: leaseOpBody(input),
  });
  if (status === 200) return { status: "renewed", lease: parseReply<WorkflowLease>(status, text) };
  if (status === 409) return { status: "lost" };
  throw toApiError(status, text);
}

async function releaseLock(http: HttpTransport, input: LeaseOpInput): Promise<void> {
  await http.request("/v0/workflows/lock/release", { method: "POST", body: leaseOpBody(input) });
}

function leaseOpBody(input: LeaseOpInput): WireLeaseOpRequest {
  return { workflow_path: input.workflowPath, session_id: input.sessionId };
}
export interface PathApiClientOptions {
  /** Base URL of a running `path-server`, e.g. `http://localhost:8080`. Trailing slash trimmed. */
  baseUrl: string;
  /** Injected `fetch`; defaults to the global. Lets a host swap in its own transport. */
  fetch?: FetchLike;
  /** Hosted mode: the Bearer token for every REST, blob and SSE call. */
  getToken?: RequestAuth["getToken"];
  /** Hosted mode: settles once the user signs in again after a `401`; the call is then retried. */
  onUnauthorized?: RequestAuth["onUnauthorized"];
}

/** A typed client over the `@path/server` v0 HTTP API (server-api-v0.md §§2–7, §10): pure TS, every
 * request through the injected `fetch`, any non-2xx raised as `PathApiError`. Each endpoint group
 * lives in `./api/`.
 */
export class PathApiClient {
  /** The normalized base URL (trailing slash trimmed). */
  readonly baseUrl: string;
  /** The resolved transport — exposed so the SSE client/connector reuse the same `fetch`. */
  readonly fetch: FetchLike;
  private readonly http: HttpTransport;
  private readonly unsignedFetch: FetchLike;
  private readonly lastToken: () => string | null;

  constructor(options: PathApiClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    const fetch = options.fetch ?? defaultFetch;
    const { getToken, onUnauthorized } = options;
    const signed = getToken ? authorizedFetch(fetch, { getToken, onUnauthorized }) : undefined;
    this.fetch = signed?.fetch ?? fetch;
    this.unsignedFetch = fetch;
    this.lastToken = signed?.lastToken ?? (() => null);
    this.http = new HttpTransport(this.baseUrl, this.fetch);
  }

  /** The base URL joined to a v0 path — exposed so the SSE client can build the events URL. */
  url(path: string): string {
    return this.http.url(path);
  }

  /** `GET /v0/runs` — list root runs, most recent first (server-api-v0.md §3). */
  listRuns(query: ListRunsQuery = {}): Promise<ListRunsResponse> {
    return listRuns(this.http, query);
  }

  /** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
  getRun(rootRunId: string): Promise<RunTreeResponse> {
    return getRun(this.http, rootRunId);
  }

  /** `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's `input` or `output` blob content. */
  getBlob(rootRunId: string, runId: string, name: BlobName): Promise<JsonValue> {
    return getBlob(this.http, rootRunId, runId, name);
  }

  /** `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2): the `202` says the abort was
   * signalled, not that the run stopped, so learn the terminal status from the event stream.
   */
  cancelRun(rootRunId: string): Promise<void> {
    return cancelRun(this.http, rootRunId);
  }

  /** `DELETE /v0/runs/:root_run_id` — permanently remove a root run from both stores; unlike
   * `cancelRun` this destroys the audit trail, so confirm first. `force` overrides the server's
   * live-successor guard.
   */
  deleteRun(rootRunId: string, options: { force?: boolean } = {}): Promise<void> {
    return deleteRun(this.http, rootRunId, options);
  }

  /** `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3): the only caller input is a
   * `config` override for the re-run steps — there is no `input`. `rerunFromRunId` is the
   * Resume-from-chosen-K boundary (ADR 0032) and forces a JSON body.
   */
  resumeRun(
    rootRunId: string,
    config?: ConfigObject,
    rerunFromRunId?: string,
  ): Promise<StartRunResponse> {
    return resumeRun(this.http, rootRunId, config, rerunFromRunId);
  }

  /** `POST /v0/runs/:step_run_id/complete` (server-api-v0.md §4.4, ADR 0039/0040/0041): validates
   * `output` against the node's `outputSchema` before the lease, so a failure is a `400` that
   * leaves the leaf `awaiting`. `config` may re-supply a secret frozen as a `[secret:<key>]` token
   * (ADR 0046).
   */
  completeStep(
    stepRunId: string,
    output: JsonValue,
    config?: ConfigObject,
  ): Promise<CompleteRunResponse> {
    return completeStep(this.http, stepRunId, output, config);
  }

  /** `POST /v0/runs` — start a run (server-api-v0.md §2). The `202` returns once the tree loads and
   * validates; translates the camelCase options inline to the snake_case wire body (ADR 0013).
   */
  startRun(options: StartRunOptions): Promise<StartRunResponse> {
    return startRun(this.http, options);
  }

  /** `GET /v0/workflows` — discover launchable workflows (server-api-v0.md §6, ADR 0011); a fresh
   * scan each call, `is_root`/`valid` are hints, not a launchability gate.
   */
  listWorkflows(): Promise<ListWorkflowsResponse> {
    return listWorkflows(this.http);
  }

  /** `POST /v0/workflows/copy` — copy a shipped workflow (a `shipped` row's `relative_path`) into
   * the user's own folder. Create-only: an existing copy is a `409`. */
  copyShippedWorkflow(shippedPath: string): Promise<{ relativePath: string; rootPath: string }> {
    return copyShippedWorkflow(this.http, shippedPath);
  }

  /** `GET /v0/templates` — the shipped∪shared∪user authoring-template union (server-api-v0.md §10.1, ADR
   * 0050); a **thin** list (no `body`) whose every entry carries its own `valid`/`error`, so a
   * broken template lists rather than vanishing.
   */
  listTemplates(): Promise<ListTemplatesResponse> {
    return listTemplates(this.http);
  }

  /** `GET /v0/templates/:id` — one template as a parsed envelope (server-api-v0.md §10.2, ADR
   * 0050); an invalid template still answers `200` with `valid: false` and a best-effort `body`.
   */
  getTemplate(id: string): Promise<GetTemplateResponse> {
    return getTemplate(this.http, id);
  }

  /** `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050): create a **user** template
   * under `users/<user-id>/template/`, the client minting the `id` inside `body`. Create-only: an
   * existing name is a `409`.
   */
  createTemplate(input: CreateTemplateInput): Promise<TemplateWriteResult> {
    return createTemplate(this.http, input);
  }

  /** `PUT /v0/templates/:id` — update a user template in place (server-api-v0.md §10.4, ADR 0050),
   * gated on `If-Match`: stale token `412`, shipped template `403`, unknown id `404`.
   */
  putTemplate(input: PutTemplateInput): Promise<TemplateWriteResult> {
    return putTemplate(this.http, input);
  }

  /** `DELETE /v0/templates/:id` — delete a user template (server-api-v0.md §10.5); a shipped
   * template is a `403`, an unknown id a `404`.
   */
  deleteTemplate(id: string): Promise<void> {
    return deleteTemplate(this.http, id);
  }

  /** `GET /v0/secrets` — the requester's User secret names and `updated_at`, never a value
   * (server-api-v0.md §11.1). Hosted mode only: local mode answers `404`. */
  listSecrets(): Promise<WireSecretSummary[]> {
    return listSecrets(this.http);
  }

  /** `PUT /v0/secrets/:name` — set or replace one User secret (server-api-v0.md §11.2); the reply
   * never echoes the value, and a limit or a reserved name is a `400`. */
  putSecret(name: string, value: string): Promise<WireSecretSummary> {
    return putSecret(this.http, name, value);
  }

  /** `DELETE /v0/secrets/:name` — remove one User secret (server-api-v0.md §11.3). */
  deleteSecret(name: string): Promise<void> {
    return deleteSecret(this.http, name);
  }

  /** `GET /v0/workflows/download?path=<relative_path>` — the saved workflow file, or a zip of the
   * files its `ref`s reach (server-api-v0.md §7.4). */
  downloadWorkflow(path: string): Promise<DownloadedFile> {
    return downloadWorkflow(this.http, path);
  }

  /** `GET /v0/templates/:id/download` — the template's on-disk file (server-api-v0.md §10.6). */
  downloadTemplate(id: string): Promise<DownloadedFile> {
    return downloadTemplate(this.http, id);
  }

  /** `GET /v0/step-plugins` — the step-plugin registry as data (server-api-v0.md §8): a bare
   * snapshot with no staleness contract, since the write route re-validates (ADR 0018).
   */
  getStepPlugins(): Promise<StepPluginsResponse> {
    return getStepPlugins(this.http);
  }

  /** `GET /v0/workflows/file?path=<relative_path>` — the raw bytes of one workflow file
   * (server-api-v0.md §7.1), text rather than parsed JSON; a `404` (file gone, path escapes the
   * root, or a symlink component) throws.
   */
  getWorkflowFile(path: string): Promise<WorkflowFileRaw> {
    return getWorkflowFile(this.http, path);
  }

  /** `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the path rides the body (no `%2F`
   * encoding); a present `ifMatch` is the overwrite precondition, and a `412` says the file changed
   * since it was read.
   */
  putWorkflow(input: PutWorkflowInput): Promise<PutWorkflowResult> {
    return putWorkflow(this.http, input);
  }

  /** `DELETE /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.2): the required
   * `ifMatch` is the ETag of the bytes last read or wrote, so a delete never removes unseen bytes;
   * `sessionId` names the caller's own edit lease.
   */
  deleteWorkflowFile(input: DeleteWorkflowInput): Promise<void> {
    return deleteWorkflowFile(this.http, input);
  }

  /** `POST /v0/workflows/lock` (ADR 0017): acquire or take over one file's edit lease; a `409` held
   * by another live session is the normal `held-by-other` result, not a throw.
   */
  acquireLock(input: AcquireLockInput): Promise<AcquireLockResult> {
    return acquireLock(this.http, input);
  }

  /** `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew the lease; a `409` (reclaimed after
   * expiry, or taken over) is the normal `lost` result, not a throw.
   */
  heartbeatLock(input: LeaseOpInput): Promise<HeartbeatResult> {
    return heartbeatLock(this.http, input);
  }

  /** `POST /v0/workflows/lock/release` (ADR 0017): idempotent, and the server deletes only when
   * `session_id` matches, so a stale beacon can never free another session's lease.
   */
  releaseLock(input: LeaseOpInput): Promise<void> {
    return releaseLock(this.http, input);
  }

  /** `releaseLock` for a closing page: a `keepalive` POST that outlives the page, signed with the
   * last token sent because an unload cannot wait for a fresh one. Best-effort: a failure is
   * dropped, and the server's TTL reaps the lease (ADR 0017). */
  releaseLockOnUnload(input: LeaseOpInput): void {
    const token = this.lastToken();
    this.unsignedFetch(this.url("/v0/workflows/lock/release"), {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(token !== null ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(leaseOpBody(input)),
    }).catch(() => {});
  }
}
