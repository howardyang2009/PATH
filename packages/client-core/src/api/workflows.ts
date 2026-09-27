import type {
  JsonValue,
  ListWorkflowsResponse,
  StepPluginsResponse,
  WirePutWorkflowRequest,
  WirePutWorkflowResponse,
} from "@path/schema";
import { type HttpTransport, ifMatchHeader } from "./transport.js";

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

/** The raw read of one workflow file (`GET /v0/workflows/file`, server-api-v0.md §7.1): the exact on-disk bytes as
 * text, never the loader's parse, so the Designer keeps unknown fields and an **id-less** file it stamps on import
 * (ADR 0015).
 */
export interface WorkflowFileRaw {
  text: string;
  etag: string | null;
}

export function listWorkflows(http: HttpTransport): Promise<ListWorkflowsResponse> {
  return http.requestJson<ListWorkflowsResponse>("/v0/workflows");
}

export function getStepPlugins(http: HttpTransport): Promise<StepPluginsResponse> {
  return http.requestJson<StepPluginsResponse>("/v0/step-plugins");
}

export async function getWorkflowFile(http: HttpTransport, path: string): Promise<WorkflowFileRaw> {
  const reply = await http.request(`/v0/workflows/file?path=${encodeURIComponent(path)}`);
  return { text: reply.text, etag: reply.headers.get("ETag") };
}

export async function putWorkflow(
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

export async function deleteWorkflowFile(
  http: HttpTransport,
  input: { path: string; ifMatch: string; sessionId?: string },
): Promise<void> {
  const query = new URLSearchParams({ path: input.path });
  if (input.sessionId !== undefined) query.set("session_id", input.sessionId);
  await http.request(`/v0/workflows/file?${query.toString()}`, {
    method: "DELETE",
    headers: { "If-Match": input.ifMatch },
  });
}
