import { resolve } from "node:path";
import type { WireCopyWorkflowResponse } from "@path/schema";
import { z } from "zod";
import { readRequestBody, sendError, sendJson } from "../http-json.js";
import { copyShippedWorkflow, shippedWorkflowDir } from "../shipped-workflows.js";
import type { ApiRequest } from "./route-context.js";

const CopyWorkflowBodySchema = z.object({ shipped_path: z.string().min(1) }).strict();

/**
 * `POST /v0/workflows/copy` (server-api-v0.md §7.3, ADR 0086): copy a shipped workflow into the
 * current user's workflow root, create-only. `shipped_path` is the `relative_path` a shipped row of
 * `GET /v0/workflows` carries.
 */
export async function handlePostWorkflowCopy({ req, res, ctx }: ApiRequest): Promise<void> {
  const body = await readRequestBody(req, res, CopyWorkflowBodySchema);
  if (!body) return;

  const copied = copyShippedWorkflow(
    resolve(ctx.project.dir),
    shippedWorkflowDir(ctx),
    body.data.shipped_path,
  );
  if (!copied.ok) {
    sendError(res, copied.status, copied.message);
    return;
  }
  const reply: WireCopyWorkflowResponse = { relative_path: copied.relativePath };
  sendJson(res, 201, reply);
}
