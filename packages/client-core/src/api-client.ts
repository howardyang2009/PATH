import type {
  BlobName,
  CompleteRunResponse,
  ConfigObject,
  GetTemplateResponse,
  JsonValue,
  ListRunsResponse,
  ListTemplatesResponse,
  ListWorkflowsResponse,
  RunTreeResponse,
  StartRunResponse,
  StepPluginsResponse,
} from "@path/schema";
import type {
  AcquireLockInput,
  AcquireLockResult,
  HeartbeatResult,
  LeaseOpInput,
} from "./api/leases.js";
import * as leases from "./api/leases.js";
import type { ListRunsQuery, StartRunOptions } from "./api/runs.js";
import * as runs from "./api/runs.js";
import type {
  CreateTemplateInput,
  PutTemplateInput,
  TemplateWriteResult,
} from "./api/templates.js";
import * as templates from "./api/templates.js";
import { defaultFetch, type FetchLike, HttpTransport } from "./api/transport.js";
import type { PutWorkflowInput, PutWorkflowResult, WorkflowFileRaw } from "./api/workflows.js";
import * as workflows from "./api/workflows.js";

export type {
  AcquireLockInput,
  AcquireLockResult,
  HeartbeatResult,
  LeaseOpInput,
  WorkflowLease,
} from "./api/leases.js";
export type { ListRunsQuery, StartRunOptions } from "./api/runs.js";
export type {
  CreateTemplateInput,
  PutTemplateInput,
  TemplateWriteResult,
} from "./api/templates.js";
export { defaultFetch, type FetchLike, PathApiError } from "./api/transport.js";
export type { PutWorkflowInput, PutWorkflowResult, WorkflowFileRaw } from "./api/workflows.js";

export interface PathApiClientOptions {
  /** Base URL of a running `path-server`, e.g. `http://localhost:8080`. Trailing slash trimmed. */
  baseUrl: string;
  /** Injected `fetch`; defaults to the global. Lets a host swap in its own transport. */
  fetch?: FetchLike;
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

  constructor(options: PathApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? defaultFetch;
    this.http = new HttpTransport(this.baseUrl, this.fetch);
  }

  /** The base URL joined to a v0 path — exposed so the SSE client can build the events URL. */
  url(path: string): string {
    return this.http.url(path);
  }

  /** `GET /v0/runs` — list root runs, most recent first (server-api-v0.md §3). */
  listRuns(query: ListRunsQuery = {}): Promise<ListRunsResponse> {
    return runs.listRuns(this.http, query);
  }

  /** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
  getRun(rootRunId: string): Promise<RunTreeResponse> {
    return runs.getRun(this.http, rootRunId);
  }

  /** `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's `input` or `output` blob content. */
  getBlob(rootRunId: string, runId: string, name: BlobName): Promise<JsonValue> {
    return runs.getBlob(this.http, rootRunId, runId, name);
  }

  /** `POST /v0/runs/:root_run_id/cancel` (server-api-v0.md §4.2): the `202` says the abort was
   * signalled, not that the run stopped, so learn the terminal status from the event stream.
   */
  cancelRun(rootRunId: string): Promise<void> {
    return runs.cancelRun(this.http, rootRunId);
  }

  /** `DELETE /v0/runs/:root_run_id` — permanently remove a root run from both stores; unlike
   * `cancelRun` this destroys the audit trail, so confirm first. `force` overrides the server's
   * live-successor guard.
   */
  deleteRun(rootRunId: string, options: { force?: boolean } = {}): Promise<void> {
    return runs.deleteRun(this.http, rootRunId, options);
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
    return runs.resumeRun(this.http, rootRunId, config, rerunFromRunId);
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
    return runs.completeStep(this.http, stepRunId, output, config);
  }

  /** `POST /v0/runs` — start a run (server-api-v0.md §2). The `202` returns once the tree loads and
   * validates; translates the camelCase options inline to the snake_case wire body (ADR 0013).
   */
  startRun(options: StartRunOptions): Promise<StartRunResponse> {
    return runs.startRun(this.http, options);
  }

  /** `GET /v0/workflows` — discover launchable workflows (server-api-v0.md §6, ADR 0011); a fresh
   * scan each call, `is_root`/`valid` are hints, not a launchability gate.
   */
  listWorkflows(): Promise<ListWorkflowsResponse> {
    return workflows.listWorkflows(this.http);
  }

  /** `GET /v0/templates` — the shipped∪user authoring-template union (server-api-v0.md §10.1, ADR
   * 0050); a **thin** list (no `body`) whose every entry carries its own `valid`/`error`, so a
   * broken template lists rather than vanishing.
   */
  listTemplates(): Promise<ListTemplatesResponse> {
    return templates.listTemplates(this.http);
  }

  /** `GET /v0/templates/:id` — one template as a parsed envelope (server-api-v0.md §10.2, ADR
   * 0050); an invalid template still answers `200` with `valid: false` and a best-effort `body`.
   */
  getTemplate(id: string): Promise<GetTemplateResponse> {
    return templates.getTemplate(this.http, id);
  }

  /** `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050): create a **user** template
   * under `.path/template/`, the client minting the `id` inside `body`. Create-only: an existing
   * name is a `409`.
   */
  createTemplate(input: CreateTemplateInput): Promise<TemplateWriteResult> {
    return templates.createTemplate(this.http, input);
  }

  /** `PUT /v0/templates/:id` — update a user template in place (server-api-v0.md §10.4, ADR 0050),
   * gated on `If-Match`: stale token `412`, shipped template `403`, unknown id `404`.
   */
  putTemplate(input: PutTemplateInput): Promise<TemplateWriteResult> {
    return templates.putTemplate(this.http, input);
  }

  /** `DELETE /v0/templates/:id` — delete a user template (server-api-v0.md §10.5); a shipped
   * template is a `403`, an unknown id a `404`.
   */
  deleteTemplate(id: string): Promise<void> {
    return templates.deleteTemplate(this.http, id);
  }

  /** `GET /v0/step-plugins` — the step-plugin registry as data (server-api-v0.md §8): a bare
   * snapshot with no staleness contract, since the write route re-validates (ADR 0018).
   */
  getStepPlugins(): Promise<StepPluginsResponse> {
    return workflows.getStepPlugins(this.http);
  }

  /** `GET /v0/workflows/file?path=<relative_path>` — the raw bytes of one workflow file
   * (server-api-v0.md §7.1), text rather than parsed JSON; a `404` (file gone, path escapes the
   * root, or a symlink component) throws.
   */
  getWorkflowFile(path: string): Promise<WorkflowFileRaw> {
    return workflows.getWorkflowFile(this.http, path);
  }

  /** `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the path rides the body (no `%2F`
   * encoding); a present `ifMatch` is the overwrite precondition, and a `412` says the file changed
   * since it was read.
   */
  putWorkflow(input: PutWorkflowInput): Promise<PutWorkflowResult> {
    return workflows.putWorkflow(this.http, input);
  }

  /** `DELETE /v0/workflows/file?path=<relative_path>` (server-api-v0.md §7.2): the required
   * `ifMatch` is the ETag of the bytes last read or wrote, so a delete never removes unseen bytes;
   * `sessionId` names the caller's own edit lease.
   */
  deleteWorkflowFile(input: { path: string; ifMatch: string; sessionId?: string }): Promise<void> {
    return workflows.deleteWorkflowFile(this.http, input);
  }

  /** `POST /v0/workflows/lock` (ADR 0017): acquire or take over one file's edit lease; a `409` held
   * by another live session is the normal `held-by-other` result, not a throw.
   */
  acquireLock(input: AcquireLockInput): Promise<AcquireLockResult> {
    return leases.acquireLock(this.http, input);
  }

  /** `POST /v0/workflows/lock/heartbeat` (ADR 0017): renew the lease; a `409` (reclaimed after
   * expiry, or taken over) is the normal `lost` result, not a throw.
   */
  heartbeatLock(input: LeaseOpInput): Promise<HeartbeatResult> {
    return leases.heartbeatLock(this.http, input);
  }

  /** `POST /v0/workflows/lock/release` (ADR 0017): idempotent, and the server deletes only when
   * `session_id` matches, so a stale beacon can never free another session's lease.
   */
  releaseLock(input: LeaseOpInput): Promise<void> {
    return leases.releaseLock(this.http, input);
  }
}
