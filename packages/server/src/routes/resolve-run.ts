import type { RunTree } from "@path/engine";
import type { RunRecord } from "@path/schema";
import type { RouteContext } from "./route-context.js";

/**
 * What a `/v0/runs/*` request is about (server-api-v0.md §4): one lookup, so every run door agrees
 * on which row answers and on the wording of a `404`.
 *
 * The row that answers a question about a tree is the tree's own **root** row, never a child. A
 * child can read `succeeded` while the tree still runs (and `running` under a settled tree), so a
 * terminality or waiting verdict taken from one would be wrong. `RunTree.root` is `null` exactly
 * when the tree has rows but not that one, and an address that needs the root row refuses rather
 * than guessing at any row of the tree.
 */

/** The tree a root-run id names, or the `404` every run door shares. */
export type TreeAddress =
  | { ok: true; rootRunId: string; tree: RunTree }
  | { ok: false; status: 404; message: string };

/** A tree **and** its root row — what an acting door (cancel, delete, resume) addresses. */
export type RunAddress =
  | { ok: true; rootRunId: string; tree: RunTree; root: RunRecord }
  | { ok: false; status: 404; message: string };

/** A parked leaf's own tree, its root row (`null` when the tree has no root row) and the leaf row —
 * what `POST /v0/runs/:step_run_id/complete` addresses. */
export type LeafAddress =
  | { ok: true; rootRunId: string; tree: RunTree; root: RunRecord | null; leaf: RunRecord }
  | { ok: false; status: 404; message: string };

function treeAddress(ctx: RouteContext, rootRunId: string): TreeAddress {
  const tree = ctx.project.archive.tree(rootRunId);
  if (tree === null) return notFound(rootRunId);
  return { ok: true, rootRunId, tree };
}

function notFound(rootRunId: string): { ok: false; status: 404; message: string } {
  return { ok: false, status: 404, message: `no run found with id "${rootRunId}"` };
}

/** The tree a root-run id names. A **read** door (the detail, the event stream, a blob) needs no
 * more: the row it prints is its own choice, and a tree whose root row is missing is still that
 * tree's rows. */
export function resolveTree(ctx: RouteContext, rootRunId: string): TreeAddress {
  return treeAddress(ctx, rootRunId);
}

/** The tree and its root row. An **acting** door calls this: without the root row there is no
 * status to gate the action on, and guessing at a child's would refuse a live run's cancel. */
export function resolveRun(ctx: RouteContext, rootRunId: string): RunAddress {
  const address = treeAddress(ctx, rootRunId);
  if (!address.ok) return address;
  const { root } = address.tree;
  if (root === null) return notFound(rootRunId);
  return { ...address, root };
}

/** The leaf a step-run id names, resolved through the one row that knows its root. An id that names
 * no row at all — or no row under the root it claims — is the `404`. */
export function resolveLeaf(ctx: RouteContext, stepRunId: string): LeafAddress {
  const rootRunId = ctx.project.archive.rootRunIdOf(stepRunId);
  const tree = rootRunId === null ? null : ctx.project.archive.tree(rootRunId);
  const leaf = tree?.runs.find((run) => run.runId === stepRunId);
  if (rootRunId === null || tree === null || leaf === undefined) {
    return { ok: false, status: 404, message: `no step run found with id "${stepRunId}"` };
  }
  return { ok: true, rootRunId, tree, root: tree.root, leaf };
}
