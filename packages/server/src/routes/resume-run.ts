import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, relative } from "node:path";
import { loadWorkflowTree } from "@path/engine";
import { isTerminal, type StartRunResponse } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import { ResumeNotFound } from "../live-runs.js";
import { resolveWorkflowPath, type RunsRouteContext } from "./post-runs.js";

/**
 * `POST /v0/runs/:root_run_id/resume` (server-api-v0.md §4.3) — re-runs a finished-but-unsuccessful
 * root run as a **successor** (ADR 0001, engine #173). Like `cancel` (§4.2) it is a named action on
 * an existing run, and like `POST /v0/runs` it answers `202` with the successor's *own* fresh ids as
 * soon as the run starts, then the client watches that new run's SSE stream to its terminal status.
 *
 * The workflow file to re-run is recovered from the predecessor's own row (`workflow_path`, stored
 * since engine #169), so the caller sends no body: a resume names *which run* to continue, not what
 * to run. No `input`/`config` either — a resumed run restores its context from the predecessor's
 * tree, so a fresh seed would be silently discarded (engine `cli.ts`).
 *
 * Each refusal names a distinct reason a resume cannot happen, so the client can tell "not finished
 * yet" from "already succeeded" from "the workflow file is gone".
 */
export async function handleResumeRun(res: ServerResponse, ctx: RunsRouteContext, rootRunId: string): Promise<void> {
  // The predecessor's root row, or null — the same `RunTree.root` `cancel` keys on, never some other
  // row of the tree whose status could disagree with the root's.
  const root = ctx.project.archive.tree(rootRunId)?.root;
  if (!root) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  // Only a finished-but-unsuccessful run is resumable. A still-running run has nothing to resume yet;
  // a succeeded run has nothing left to do. `cancelled` and `failed` fall through.
  if (!isTerminal(root.status)) {
    sendError(res, 409, `run "${rootRunId}" is still ${root.status}; only a finished run can be resumed`);
    return;
  }
  if (root.status === "succeeded") {
    sendError(res, 409, `run "${rootRunId}" already succeeded; there is nothing to resume`);
    return;
  }

  // A run recorded before #169, or one written without a path, cannot be re-run: the server has no
  // way to recover which workflow file it was.
  if (!root.workflowPath) {
    sendError(res, 409, `run "${rootRunId}" has no recorded workflow path and cannot be resumed`);
    return;
  }

  const absPath = resolveWorkflowPath(ctx.project.dir, root.workflowPath);
  if (!absPath || !existsSync(absPath)) {
    sendError(res, 404, `workflow file for run "${rootRunId}" not found at "${root.workflowPath}"`);
    return;
  }

  // Re-read and re-validate the workflow: a resumed successor runs the file as it stands now, so a
  // file that has since become invalid is a `400`, exactly as a fresh launch of it would be.
  const loadResult = loadWorkflowTree(absPath);
  if (!loadResult.success) {
    sendError(res, 400, "workflow validation failed", loadResult.errors);
    return;
  }
  const { tree } = loadResult;
  const rootFile = tree.files.get(tree.rootPath);
  if (!rootFile) {
    sendError(res, 500, "internal error: root file missing from loaded tree");
    return;
  }

  // The file at that path must still be the *same workflow* this run ran (identity is the `id`, ADR
  // 0006). The path was recovered from the row, not re-confirmed by the operator as it is on `path
  // run --resume`, so a different workflow swapped in at that path would otherwise be resumed against
  // the predecessor's restored context — nodes keyed to a structure that may no longer exist. Only
  // enforced when the predecessor recorded an id (every run since #169 does).
  if (root.workflowId && rootFile.id !== root.workflowId) {
    sendError(
      res,
      409,
      `the workflow at "${root.workflowPath}" is no longer the one run "${rootRunId}" ran (its id changed); cannot resume`,
    );
    return;
  }

  let ids;
  try {
    ids = await ctx.live.resume(rootFile, rootRunId, dirname(tree.rootPath), {
      files: tree.files,
      // Recorded on the successor's root row so it is itself resumable.
      sourceWorkflowPath: relative(ctx.project.dir, tree.rootPath),
    });
  } catch (err) {
    // The row vanished between the check above and the engine's own lookup (a concurrent `rm`).
    if (err instanceof ResumeNotFound) {
      sendError(res, 404, `no run found with id "${rootRunId}"`);
      return;
    }
    sendError(res, 500, `resume failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const started: StartRunResponse = { run_id: ids.runId, root_run_id: ids.rootRunId };
  sendJson(res, 202, started);
}
