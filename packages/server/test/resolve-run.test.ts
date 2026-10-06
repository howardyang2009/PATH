import type { RunTree } from "@path/engine";
import type { RunRecord } from "@path/schema";
import { describe, expect, it } from "vitest";
import { resolveLeaf, resolveRun, resolveTree } from "../src/routes/resolve-run.js";
import type { RouteContext } from "../src/routes/route-context.js";

/**
 * The one address lookup behind every `/v0/runs/*` door. Its own interface is what the doors share:
 * a tree by root-run id, a tree plus its root row for an acting door, and a leaf's own tree. These
 * drive it directly with a stubbed archive, so the root-row rule is tested once instead of per
 * route.
 */

function row(over: Partial<RunRecord> & Pick<RunRecord, "runId" | "status">): RunRecord {
  return {
    rootRunId: over.runId,
    parentRunId: null,
    nodeId: null,
    nodeName: null,
    workerName: null,
    iteration: null,
    pass: null,
    startedAt: null,
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    rerunFromNodePath: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    launchFacts: null,
    ...over,
  } as RunRecord;
}

/** A context whose archive answers from one table of trees, keyed by root-run id. Each tree is the
 * rows given; `root` is the row whose own id is the key, or `null` when it is absent. */
function context(trees: Record<string, RunRecord[]>, roots: Record<string, string> = {}) {
  const built = new Map<string, RunTree>(
    Object.entries(trees).map(([rootRunId, runs]) => [
      rootRunId,
      {
        rootRunId,
        runs,
        root: runs.find((r) => r.runId === rootRunId) ?? null,
        has: (runId: string) => runs.some((r) => r.runId === runId),
      } as RunTree,
    ]),
  );
  const archive = {
    tree: (rootRunId: string) => built.get(rootRunId) ?? null,
    rootRunIdOf: (runId: string) => roots[runId] ?? null,
  };
  return { store: { archive } } as unknown as RouteContext;
}

const ROOT = "run-root";
const CHILD = "run-child";

describe("resolveTree", () => {
  it("answers with the tree, whatever its rows are", () => {
    const ctx = context({ [ROOT]: [row({ runId: CHILD, status: "succeeded" })] });

    const address = resolveTree(ctx, ROOT);

    expect(address.ok && address.tree.runs).toHaveLength(1);
  });

  it("names the one 404 wording", () => {
    const address = resolveTree(context({}), "nope");

    expect(address).toEqual({
      ok: false,
      status: 404,
      message: 'no run found with id "nope"',
    });
  });
});

describe("resolveRun", () => {
  it("answers with the tree and its own root row", () => {
    const root = row({ runId: ROOT, status: "running" });
    const address = resolveRun(
      context({ [ROOT]: [root, row({ runId: CHILD, status: "succeeded" })] }),
      ROOT,
    );

    expect(address.ok && address.root).toBe(root);
  });

  // The rule the doors used to restate in comments: a child's status is not the tree's.
  it("refuses when the tree has rows but no root row", () => {
    const ctx = context({ [ROOT]: [row({ runId: CHILD, status: "succeeded" })] });

    expect(resolveRun(ctx, ROOT)).toEqual({
      ok: false,
      status: 404,
      message: `no run found with id "${ROOT}"`,
    });
  });
});

describe("resolveLeaf", () => {
  it("answers with the leaf, its tree and its root row", () => {
    const root = row({ runId: ROOT, status: "running" });
    const leaf = row({ runId: CHILD, status: "awaiting", parentRunId: ROOT });
    const address = resolveLeaf(context({ [ROOT]: [root, leaf] }, { [CHILD]: ROOT }), CHILD);

    expect(address.ok && address.leaf).toBe(leaf);
    expect(address.ok && address.root).toBe(root);
  });

  it("answers for a leaf whose tree has no root row", () => {
    const leaf = row({ runId: CHILD, status: "awaiting" });
    const address = resolveLeaf(context({ [ROOT]: [leaf] }, { [CHILD]: ROOT }), CHILD);

    expect(address.ok && address.root).toBeNull();
  });

  it("404s an id that names no row", () => {
    expect(resolveLeaf(context({}), "nope")).toEqual({
      ok: false,
      status: 404,
      message: 'no step run found with id "nope"',
    });
  });
});
