import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { getRunsForRoot, readJsonBlob, runBlobDir } from "@path/engine";
import { sendError, sendJson } from "../http-json.js";
import type { RunsRouteContext } from "./post-runs.js";

/** The only blob names this route serves — a fixed enum, so `name` is never a raw filename. */
const BLOB_FILENAME: Record<string, string> = {
  input: "input.json",
  output: "output.json",
};

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
  const filename = BLOB_FILENAME[name];
  if (filename === undefined) {
    sendError(res, 404, `unknown blob name "${name}" (expected "input" or "output")`);
    return;
  }

  // The run must belong to the root's tree — an unknown root or a run_id outside it is a 404.
  const rows = getRunsForRoot(ctx.project.db, rootRunId);
  if (!rows.some((row) => row.runId === runId)) {
    sendError(res, 404, `no run "${runId}" under root "${rootRunId}"`);
    return;
  }

  const dir = runBlobDir(ctx.project.dir, rootRunId, runId);
  if (!existsSync(join(dir, filename))) {
    sendError(res, 404, `no ${name} blob for run "${runId}"`);
    return;
  }

  sendJson(res, 200, readJsonBlob(dir, filename));
}
