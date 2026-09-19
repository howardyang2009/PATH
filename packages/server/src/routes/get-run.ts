import type { ServerResponse } from "node:http";
import { sendError, sendJson } from "../http-json.js";
import { toWireLaunchFacts, toWireRunRecord } from "@path/schema";
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
  // What the run was launched with (ADR 0046) — a per-tree fact, so it sits beside `runs` rather than
  // on each row. Absent for a launch that supplied nothing beyond the file; its config is stored
  // masked, with `secret_keys` naming the values a continuation must be given again.
  const launchFacts = ctx.project.archive.launchFacts(rootRunId);

  sendJson(res, 200, {
    root_run_id: rootRunId,
    status: rootRow.status,
    output: tree.output() ?? null,
    runs: tree.runs.map(toWireRunRecord),
    ...(launchFacts === undefined ? {} : { launch_facts: toWireLaunchFacts(launchFacts) }),
  });
}
