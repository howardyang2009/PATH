import type { ServerResponse } from "node:http";
import { sendError, sendJson } from "../http-json.js";
import { toWireRunRecord } from "@path/schema";
import type { RunsRouteContext } from "./post-runs.js";

export function handleGetRun(res: ServerResponse, ctx: RunsRouteContext, rootRunId: string): void {
  const tree = ctx.project.archive.tree(rootRunId);
  if (!tree) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  // Unlike the cancel route, this one still reports a tree when the root row is missing — the
  // status it falls back to is the earliest row's, which is the best account of the tree available.
  // `output` does not fall back with it: `tree.output()` is the *root's* output, and a child's
  // `output.json` is that child's, not the run's.
  const rootRow = tree.root ?? tree.runs[0]!;

  sendJson(res, 200, {
    root_run_id: rootRunId,
    status: rootRow.status,
    output: tree.output() ?? null,
    runs: tree.runs.map(toWireRunRecord),
  });
}
