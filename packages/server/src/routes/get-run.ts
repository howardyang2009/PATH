import { toWireLaunchFacts, toWireRunRecord } from "@path/schema";
import { sendError, sendJson } from "../http-json.js";
import type { ApiRequest } from "./route-context.js";

export function handleGetRun({ res, ctx, params: [rootRunId] }: ApiRequest<[string]>): void {
  const tree = ctx.project.archive.tree(rootRunId);
  if (!tree) {
    sendError(res, 404, `no run found with id "${rootRunId}"`);
    return;
  }

  // Still reports a tree when the root row is missing, falling back to the earliest row's status.
  // `output` does not fall back: `tree.output()` is the *root's* output, not a child's.
  const rootRow = tree.root ?? tree.runs[0]!;
  // What the run was launched with (ADR 0046) — a per-tree fact. Absent for a bare launch; its config
  // is stored masked, with `secret_keys` naming the values a continuation must be given again.
  const launchFacts = ctx.project.archive.launchFacts(rootRunId);

  sendJson(res, 200, {
    root_run_id: rootRunId,
    status: rootRow.status,
    output: tree.output() ?? null,
    runs: tree.runs.map(toWireRunRecord),
    ...(launchFacts === undefined ? {} : { launch_facts: toWireLaunchFacts(launchFacts) }),
  });
}
