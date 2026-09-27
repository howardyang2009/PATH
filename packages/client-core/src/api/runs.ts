import type {
  BlobName,
  CompleteRunRequest,
  CompleteRunResponse,
  ConfigObject,
  JsonValue,
  ListRunsResponse,
  LogBackendId,
  RunStatus,
  RunTreeResponse,
  StartRunRequest,
  StartRunResponse,
} from "@path/schema";
import type { HttpTransport } from "./transport.js";

export interface ListRunsQuery {
  limit?: number;
  status?: RunStatus;
  /** Scope to one workflow's `id` (ADR 0015 identity, not path); a server-side filter past the latest-N window, so it
   * returns that workflow's complete history.
   */
  workflowId?: string;
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

export function listRuns(http: HttpTransport, query: ListRunsQuery): Promise<ListRunsResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.status !== undefined) params.set("status", query.status);
  if (query.workflowId !== undefined) params.set("workflow_id", query.workflowId);
  const qs = params.toString();
  return http.requestJson<ListRunsResponse>(`/v0/runs${qs ? `?${qs}` : ""}`);
}

export function getRun(http: HttpTransport, rootRunId: string): Promise<RunTreeResponse> {
  return http.requestJson<RunTreeResponse>(`/v0/runs/${encodeURIComponent(rootRunId)}`);
}

export function getBlob(
  http: HttpTransport,
  rootRunId: string,
  runId: string,
  name: BlobName,
): Promise<JsonValue> {
  return http.requestJson<JsonValue>(
    `/v0/runs/${encodeURIComponent(rootRunId)}/blobs/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
  );
}

export async function cancelRun(http: HttpTransport, rootRunId: string): Promise<void> {
  await http.request(`/v0/runs/${encodeURIComponent(rootRunId)}/cancel`, { method: "POST" });
}

export async function deleteRun(
  http: HttpTransport,
  rootRunId: string,
  options: { force?: boolean },
): Promise<void> {
  const qs = options.force ? "?force=true" : "";
  await http.request(`/v0/runs/${encodeURIComponent(rootRunId)}${qs}`, { method: "DELETE" });
}

export function resumeRun(
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

export function completeStep(
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

export function startRun(http: HttpTransport, options: StartRunOptions): Promise<StartRunResponse> {
  const body: StartRunRequest = { workflow_path: options.workflowPath };
  if (options.input !== undefined) body.input = options.input;
  if (options.config !== undefined) body.config = options.config;
  if (options.workerDefaults !== undefined) body.worker_defaults = options.workerDefaults;
  if (options.logBackends !== undefined) body.log_backends = options.logBackends;
  if (options.processorConcurrency !== undefined)
    body.processor_concurrency = options.processorConcurrency;
  return http.requestJson<StartRunResponse>("/v0/runs", { method: "POST", body });
}
