import { displayStatusByRun, must, toWireLaunchFacts, toWireRunRecord } from "@path/schema";
import { type RouteReply, replyError } from "../http-json.js";
import { resolveTree } from "./resolve-run.js";
import type { ApiRequest } from "./route-context.js";

export function handleGetRun({ ctx, params: [rootRunId] }: ApiRequest<[string]>): RouteReply {
  // A read door: the tree's rows are enough, and its status falls back to the earliest row when the
  // root row is missing. `output` does not fall back: `tree.output()` is the *root's* output.
  const address = resolveTree(ctx, rootRunId);
  if (!address.ok) return replyError(address.status, address.message);
  const { tree } = address;
  const rootRow = must(tree.root ?? tree.runs[0], "root or earliest row of a run tree");
  // What the run was launched with (ADR 0046) — a per-tree fact. Absent for a bare launch; its
  // config is stored masked, with `secret_keys` naming the values a continuation must be given
  // again.
  const launchFacts = ctx.project.archive.launchFacts(rootRunId);

  return {
    status: 200,
    body: {
      root_run_id: rootRunId,
      status: rootRow.status,
      output: tree.output() ?? null,
      runs: tree.runs.map(toWireRunRecord),
      display_status: Object.fromEntries(displayStatusByRun(tree.runs)),
      ...(launchFacts === undefined ? {} : { launch_facts: toWireLaunchFacts(launchFacts) }),
    },
  };
}
