import { relative, resolve } from "node:path";
import { validateWorkflowFile } from "@path/engine";
import {
  identityIssues,
  nodeIdentityOccurrences,
  type WirePutWorkflowResponse,
  type WorkflowFile,
  workflowIdentityOccurrence,
} from "@path/schema";
import { z } from "zod";
import {
  checkPrecondition,
  PRECONDITION_FAILED,
  readArtifact,
  writeArtifact,
} from "../artifact-file.js";
import { confineToProjectRoot } from "../confine.js";
import { readRequestBody, sendError } from "../http-json.js";
import { firstHeader } from "../origin-gate.js";
import { isTemplatePath } from "../template-store.js";
import type { ApiRequest } from "./route-context.js";

/**
 * The write envelope (server-api-v0.md §7): the resource path travels in the body, so a `/`-bearing
 * `workflow_path` needs no `%2F` encoding. `workflow`'s shape is validated against `@path/schema` below.
 */
const PutWorkflowBodySchema = z
  .object({
    workflow_path: z.string().min(1),
    workflow: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * The internally-duplicate-`id` check this door owns (ADR 0015); the workflow's own `id` shares the
 * nodes' namespace. Each issue becomes one `error.details` line naming both offending paths.
 */
function duplicateIdErrors(file: WorkflowFile): string[] {
  const occurrences = [workflowIdentityOccurrence(file), ...nodeIdentityOccurrences(file)];
  return identityIssues(occurrences, ["duplicate-id"]).map((issue) => {
    const path = [...issue.path, "id"].join(".");
    const first = [...(issue.firstPath ?? []), "id"].join(".");
    return `${path}: duplicate id "${String(issue.value)}": id already used at ${first}`;
  });
}

/**
 * `PUT /v0/workflows` (server-api-v0.md §7, ADR 0016): the write door for create and overwrite. The
 * server is identity-agnostic (ADR 0015): it validates `id` shape but never mints or diffs it.
 */
export async function handlePutWorkflow({ req, res, ctx }: ApiRequest): Promise<void> {
  const body = await readRequestBody(req, res, PutWorkflowBodySchema);
  if (!body) return;
  const { workflow_path: workflowPath } = body.data;

  // The two write doors are disjoint (§10.6): a template is written only through `/v0/templates`.
  if (isTemplatePath(resolve(ctx.project.dir), workflowPath)) {
    sendError(res, 400, "workflow path must not be a template path");
    return;
  }

  // Serialize the *raw* object, not zod's parsed copy, so the author's key order survives (ADR 0016).
  const rawWorkflow = (body.raw as { workflow: unknown }).workflow;

  // Path confinement (404) before schema (400): a path that escapes the root or traverses a symlink is
  // refused regardless of what the body says.
  const absPath = confineToProjectRoot(resolve(ctx.project.dir), workflowPath, {
    allowMissingTail: true,
  });
  if (absPath === undefined) {
    sendError(res, 404, "not found");
    return;
  }

  const validation = await validateWorkflowFile(rawWorkflow);
  if (!validation.success) {
    sendError(res, 400, "workflow validation failed", validation.errors);
    return;
  }
  const duplicates = duplicateIdErrors(validation.file);
  if (duplicates.length > 0) {
    sendError(res, 400, "workflow validation failed", duplicates);
    return;
  }

  // Precondition and write are one synchronous block (ADR 0016): `If-Match` present is overwrite-only,
  // absent is create-only, and every conflict is a `412` here.
  const precondition = checkPrecondition(
    readArtifact(absPath),
    firstHeader(req.headers["if-match"]),
    "create-or-overwrite",
  );
  const written = precondition.ok
    ? writeArtifact(absPath, rawWorkflow, { create: precondition.create })
    : precondition;
  if (!written.ok) {
    sendError(res, 412, PRECONDITION_FAILED[written.conflict]);
    return;
  }
  const { etag } = written;
  const existed = precondition.ok && !precondition.create;
  const relativePath = relative(resolve(ctx.project.dir), absPath);
  // The reply is the shared wire shape the client decodes, so a renamed field is a compile error here.
  const reply: WirePutWorkflowResponse = {
    relative_path: relativePath,
    id: validation.file.id,
    etag,
  };
  res.writeHead(existed ? 200 : 201, { "Content-Type": "application/json", ETag: etag });
  res.end(JSON.stringify(reply));
}
