import type { WireCopyWorkflowResponse } from "@path/schema";
import { z } from "zod";
import { type RouteReply, readRequestBody, replyError } from "../http-json.js";
import { copyShippedWorkflow } from "../shipped-workflows.js";
import type { ApiRequest } from "./route-context.js";

const CopyWorkflowBodySchema = z.object({ shipped_path: z.string().min(1) }).strict();

/**
 * `POST /v0/workflows/copy` (server-api-v0.md §7.3, ADR 0086): copy a shipped workflow into the
 * current user's workflow root, never over an existing copy. `shipped_path` is the `relative_path` a shipped row of
 * `GET /v0/workflows` carries.
 */
export async function handlePostWorkflowCopy({ req, ctx }: ApiRequest): Promise<RouteReply> {
  const body = await readRequestBody(req, CopyWorkflowBodySchema);
  if (!body.ok) return body.reply;

  const copied = copyShippedWorkflow(ctx.layout, body.data.shipped_path);
  if (!copied.ok) return replyError(copied.status, copied.message);
  const reply: WireCopyWorkflowResponse = {
    relative_path: copied.relativePath,
    root_path: copied.rootPath,
  };
  return { status: 201, body: reply };
}
