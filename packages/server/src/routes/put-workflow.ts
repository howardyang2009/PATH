import type { WirePutWorkflowResponse } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { workflowsOf } from "../workflow-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * The write envelope (server-api-v0.md §7): the resource path travels in the body, so a `/`-bearing
 * `workflow_path` needs no `%2F` encoding. `workflow`'s shape is validated against `@path/schema`
 * below.
 */
const PutWorkflowBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    workflow: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the write door for create and overwrite. The
 * server is identity-agnostic (ADR 0015): it validates `id` shape but never mints or diffs it.
 */
export async function handlePutWorkflow({ req, body, ctx }: ApiRequest): Promise<RouteReply> {
  const parsed = readRequestBody(body, PutWorkflowBodySchema);
  if (!parsed.ok) return parsed.reply;

  // Serialize the *raw* object, not zod's parsed copy, so the author's key order survives (ADR
  // 0016).
  const rawWorkflow = (parsed.raw as { workflow: unknown }).workflow;
  const written = workflowsOf(ctx).write(
    parsed.data.workflow_path,
    rawWorkflow,
    firstHeader(req.headers["if-match"]),
  );
  if (!written.ok) return replyError(written.status, written.message, written.details);

  // The reply is the shared wire shape the client decodes, so a renamed field is a compile error
  // here.
  const reply: WirePutWorkflowResponse = {
    relative_path: written.relativePath,
    id: written.id,
    etag: written.etag,
  };
  return { status: written.created ? 201 : 200, headers: { ETag: written.etag }, body: reply };
}
