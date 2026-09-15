import type { IncomingMessage, ServerResponse } from "node:http";
import type { JsonValue } from "@path/schema";
import { readJsonBody, sendError, sendJson } from "../http-json.js";
import { prepareWorkflow } from "../launch.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * `POST /v0/runs/:step_run_id/complete` (ADR 0041) — resolve a parked `awaiting` leaf by a fresh
 * engine replay over the appendable tree. The path names the **leaf**; the server derives its tree's
 * root (a tree holds many awaiting leaves) and hands `Project.complete` the reloaded workflow, which
 * takes the per-root lease, transitions the leaf `awaiting → succeeded` with the supplied output, and
 * drives the tail.
 *
 * Rejections carry a distinct status so the client can tell them apart: an unknown leaf id is `404`;
 * a leaf that is not `awaiting` — a step that already succeeded, or a double-submit landing on the row
 * a prior Complete flipped — is `409`; and a Complete against a tree another Complete is already
 * advancing (the lease is held) is `409`. On acceptance the response is `202` with the leaf and root
 * ids so the client watches the root's SSE stream to the tree's next terminal or parked state.
 *
 * The fuller route contract (validate-before-lease ordering, `outputSchema` ajv validation, the origin
 * gate) is #485's; this wires the engine mechanism (#484) end to end.
 */
export async function handleCompleteRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RunsRouteContext,
  stepRunId: string,
): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    sendError(res, 400, "invalid JSON body");
    return;
  }

  if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
    sendError(res, 400, "body must be a JSON object");
    return;
  }

  const { output } = body.value as { output?: JsonValue };
  if (output === undefined) {
    sendError(res, 400, 'missing required field "output"');
    return;
  }

  // The leaf names its tree; the tree's root row carries the workflow path to reload. An unknown leaf
  // id is a 404 here, before any file work — the engine repeats the same check under the lease.
  const rootRunId = ctx.project.archive.rootRunIdOf(stepRunId);
  if (rootRunId === null) {
    sendError(res, 404, `no step run found with id "${stepRunId}"`);
    return;
  }
  const root = ctx.project.archive.tree(rootRunId)?.root;
  if (!root) {
    sendError(res, 404, `no step run found with id "${stepRunId}"`);
    return;
  }
  if (!root.workflowPath) {
    sendError(res, 409, `run "${rootRunId}" has no recorded workflow path and cannot be completed`);
    return;
  }

  // Re-read and re-validate the workflow as it stands now — the same escape/not-found/invalid gate a
  // fresh launch and a resume run (launch.ts). Complete carries Resume's file precedent: a moved file
  // or relocated store must still resolve for the replay.
  const prepared = await prepareWorkflow(ctx.project.dir, root.workflowPath, {
    notFound: () => `workflow file for run "${rootRunId}" not found at "${root.workflowPath}"`,
  });
  if (!prepared.ok) {
    sendError(res, prepared.refusal.status, prepared.refusal.message, prepared.refusal.details);
    return;
  }
  const { workflow } = prepared;

  const result = await ctx.live.complete(workflow.rootFile, rootRunId, stepRunId, output, workflow.workflowDir, {
    files: workflow.files,
    // Dispatch reuses the registry the load validated the file against (ADR 0019 sub-15); no re-scan.
    registry: workflow.registry,
  });

  if (!result.ok) {
    // `not-found` → 404; `not-awaiting` (double-submit lands here) and `lease-held` are both 409 state
    // conflicts. The engine owns the wording; the route only chooses the code.
    const status = result.reason === "not-found" ? 404 : 409;
    sendError(res, status, result.message);
    return;
  }

  sendJson(res, 202, { step_run_id: stepRunId, root_run_id: result.rootRunId });
}
