import type { ServerResponse } from "node:http";
import type { RunBlobName } from "@path/engine";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/**
 * The only blob names this route serves — a fixed set, so `name` is never a raw filename. Which
 * file each one is stored as is the archive's business, not this route's.
 */
const SERVED_BLOBS: RunBlobName[] = ["input", "output"];

function toBlobName(name: string): RunBlobName | undefined {
  return SERVED_BLOBS.find((served) => served === name);
}

/**
 * `GET /v0/runs/:root_run_id/blobs/:run_id/:name` (name ∈ {input, output}) — returns the run's
 * on-disk `input.json`/`output.json` blob, already secret-masked at the persistence boundary
 * (CONTEXT.md §Secret), as `application/json`. Closes the gap map #29 flagged: `input_ref`/
 * `output_ref` are server-local FS paths a browser client can't read directly.
 *
 * 404 when the root/run is unknown, the name isn't a served blob, or the blob file is absent.
 * `context`/`stderr` are deferred (map #40), so they resolve to an unknown name → 404.
 */
export function handleGetRunBlob(
  res: ServerResponse,
  ctx: RunsRouteContext,
  rootRunId: string,
  runId: string,
  name: string,
): void {
  const blobName = toBlobName(name);
  if (blobName === undefined) {
    sendError(res, 404, `unknown blob name "${name}" (expected "input" or "output")`);
    return;
  }

  // The run must belong to the root's tree — an unknown root or a run_id outside it is a 404, and
  // a different one from "that run has no such blob", so the two are asked separately.
  const tree = ctx.project.archive.tree(rootRunId);
  if (!tree?.has(runId)) {
    sendError(res, 404, `no run "${runId}" under root "${rootRunId}"`);
    return;
  }

  const blob = tree.blob(runId, blobName);
  if (blob === undefined) {
    sendError(res, 404, `no ${name} blob for run "${runId}"`);
    return;
  }

  sendJson(res, 200, blob);
}
