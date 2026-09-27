import type {
  GetTemplateResponse,
  JsonValue,
  ListTemplatesResponse,
  WirePostTemplateRequest,
  WireTemplateWriteResponse,
} from "@path/schema";
import { type HttpTransport, ifMatchHeader } from "./transport.js";

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

export function listTemplates(http: HttpTransport): Promise<ListTemplatesResponse> {
  return http.requestJson<ListTemplatesResponse>("/v0/templates");
}

export function getTemplate(http: HttpTransport, id: string): Promise<GetTemplateResponse> {
  return http.requestJson<GetTemplateResponse>(`/v0/templates/${encodeURIComponent(id)}`);
}

export function createTemplate(
  http: HttpTransport,
  input: CreateTemplateInput,
): Promise<TemplateWriteResult> {
  return writeTemplate(http, "/v0/templates", "POST", input, undefined);
}

export function putTemplate(
  http: HttpTransport,
  input: PutTemplateInput,
): Promise<TemplateWriteResult> {
  return writeTemplate(
    http,
    `/v0/templates/${encodeURIComponent(input.id)}`,
    "PUT",
    input.body,
    input.ifMatch,
  );
}

export async function deleteTemplate(http: HttpTransport, id: string): Promise<void> {
  await http.request(`/v0/templates/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** The one transport behind both template writes: a JSON body, an optional `If-Match`, a parsed reply. */
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
