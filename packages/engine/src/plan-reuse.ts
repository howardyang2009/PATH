import {
  findRootRun,
  isStepType,
  type RunRecord,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";

/** A re-read tree's node ids that reuse, each pointing at the original run whose data it reuses. */
export type ReusePlan = Map<string, RunRecord>;

/**
 * Which node ids of a re-read `WorkflowFile` reuse their original run, and which run each reuses
 * (resume-reuse-semantics.md): a node id reuses iff `originalRuns` holds exactly one `succeeded` run at
 * that id under the scope's parent run (`parentRunId`, or the root when omitted). Ids are unique only
 * within a file, so the scope bounds the match; `suppress` (Resume-from-K) makes those ids re-run. */
export function planReuse(
  originalRuns: RunRecord[],
  tree: WorkflowFile,
  parentRunId?: string,
  suppress?: Set<string>,
): ReusePlan {
  const plan: ReusePlan = new Map();
  const scopeRunId = parentRunId ?? findRootRun(originalRuns)?.runId;
  if (scopeRunId === undefined) return plan;

  const candidates = originalRuns.filter((run) => run.parentRunId === scopeRunId);
  for (const node of walkNodes(tree.body)) {
    if (!isStepType(node.type)) continue;
    if (suppress?.has(node.id)) continue;
    const only = recordedChild(candidates, scopeRunId, { nodeId: node.id, succeeded: true });
    if (only) plan.set(node.id, only);
  }
  return plan;
}

// Re-derived from the format so this module never imports the executor; both resolve to the same
// `WorkflowFile["body"]` member.
// both resolve to the same `WorkflowFile["body"]` member, so a call across the seam type-checks.
type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

// True when every run-producing node in a branch already reuses a succeeded original run — the winner of
// an already-decided `wait-one` race. A branch with nothing recorded to reuse does not qualify (wait-one-join.md §7).
function branchIsReusedWinner(branch: ParallelBranch, plan: ReusePlan): boolean {
  let sawRunProducing = false;
  for (const inner of walkNodes([branch])) {
    if (isStepType(inner.type)) {
      sawRunProducing = true;
      if (!plan.has(inner.id)) return false;
    }
  }
  return sawRunProducing;
}

// A fully-reused branch's completion time, the latest `finishedAt` among its reused runs; null falls back to
// declaration order.
function reusedBranchCompletion(branch: ParallelBranch, plan: ReusePlan): string | null {
  let completedAt: string | null = null;
  for (const inner of walkNodes([branch])) {
    if (isStepType(inner.type)) {
      const record = plan.get(inner.id);
      const finishedAt = record?.finishedAt ?? null;
      if (finishedAt !== null && (completedAt === null || finishedAt > completedAt))
        completedAt = finishedAt;
    }
  }
  return completedAt;
}

/** The winner to reuse when replaying a decided `wait-one` race (wait-one-join.md §7). A photo-finish can
 * leave two branches recorded `succeeded`; resume orders them by recorded completion time (the live run's
 * `seq` is not on a `RunRecord`) and breaks an exact tie by declaration order. */
export function pickReusedWaitOneWinner(
  node: ParallelNode,
  plan: ReusePlan,
): ParallelBranch | undefined {
  const winners = node.branches.filter((branch) => branchIsReusedWinner(branch, plan));
  if (winners.length <= 1) return winners[0];
  return [...winners].sort((a, b) => {
    const ca = reusedBranchCompletion(a, plan);
    const cb = reusedBranchCompletion(b, plan);
    if (ca !== cb) {
      if (ca === null) return 1;
      if (cb === null) return -1;
      return ca < cb ? -1 : 1;
    }
    return node.branches.indexOf(a) - node.branches.indexOf(b);
  })[0];
}

/** Which recorded row answers a scope: under one parent, by node id, iteration ordinal, or pass ordinal. */
export interface RecordedScopeKey {
  nodeId?: string | null;
  iteration?: number;
  pass?: number;
  succeeded?: boolean;
}

/** The **one** recorded row under `parentRunId` that answers `key`, or `undefined`: zero matches (added
 * since) and more than one (which attempt is undefined) both answer none, so the scope runs fresh. */
export function recordedChild(
  rows: readonly RunRecord[],
  parentRunId: string | undefined,
  key: RecordedScopeKey,
): RunRecord | undefined {
  if (parentRunId === undefined) return undefined;
  const matches = rows.filter(
    (r) =>
      r.parentRunId === parentRunId &&
      (key.nodeId === undefined || r.nodeId === key.nodeId) &&
      (key.iteration === undefined || r.iteration === key.iteration) &&
      (key.pass === undefined || r.pass === key.pass) &&
      (!key.succeeded || r.status === "succeeded"),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
