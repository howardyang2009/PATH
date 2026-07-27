import type { ServerResponse } from "node:http";
import { getRunsForRoot, readJsonBlob, runBlobDir } from "@path/engine";
import { sendError, sendJson } from "../http-json.js";
import { toWireRunRecord } from "@path/schema";
import type { RunsRouteContext } from "./post-runs.js";

export function handleGetRun(res: ServerResponse, ctx: RunsRouteContext, rootRunId: string): void {
  const rows = getRunsForRoot(ctx.project.db, rootRunId);
  if (rows.length === 0) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  // The root row is the one whose own id is the root id (an invariant of the run tree, §1); ties
  // its own `runStarted` insert to `parentRunId: null` too, but `runId === rootRunId` is simpler.
  const rootRow = rows.find((row) => row.runId === rootRunId) ?? rows[0]!;
  const output =
    rootRow.status === "succeeded" && rootRow.outputRef
      ? readJsonBlob(runBlobDir(ctx.project.dir, rootRunId, rootRow.runId), "output.json")
      : null;

  sendJson(res, 200, {
    root_run_id: rootRunId,
    status: rootRow.status,
    output,
    runs: rows.map(toWireRunRecord),
  });
}
