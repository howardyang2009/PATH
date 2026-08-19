import { walkNodes, type RunRecord, type WorkflowFile } from "@path/schema";

/** Node ids that produce a run row of their own (domain invariant 1) — the only ones a plan considers. */
const RUN_PRODUCING_TYPES = new Set(["prompt", "binary", "workflow"]);

/** A re-read tree's node ids that reuse, each pointing at the original run whose data it reuses. */
export type ReusePlan = Map<string, RunRecord>;

/**
 * Which node ids of a re-read `WorkflowFile` reuse their original run, and which run each reuses
 * (resume-reuse-semantics.md): a node id reuses iff `originalRuns` holds a `succeeded` run at that
 * id — matched by id alone, never by comparing input, config, or the step's own definition.
 *
 * `originalRuns` is scoped to one workflow-run's direct children before matching, not searched
 * whole: node ids are unique only within one file (release-notes.test.ts), so a nested workflow-run's
 * own descendants can carry an id that coincidentally collides with one in this file. `parentRunId`
 * names that workflow-run — the original root run when omitted (the top-level call), or a re-entered
 * nested workflow-run's original counterpart when the engine recurses into it (#172). Since
 * `walkNodes` never descends into a `workflow` step's ref (node-walk.ts), a succeeded workflow-run's
 * whole subtree is collapsed for free — nothing inside it is a candidate, and nothing inside it is
 * ever inspected.
 *
 * A `while-do` body's node id repeats once per iteration, so more than one succeeded row can share
 * an id — which recorded attempt answers a single re-read node is undefined, so an id with more than
 * one succeeded candidate does not reuse rather than guessing at one.
 */
export function planReuse(originalRuns: RunRecord[], tree: WorkflowFile, parentRunId?: string): ReusePlan {
  const plan: ReusePlan = new Map();
  const scopeRunId = parentRunId ?? originalRuns.find((run) => run.parentRunId === null)?.runId;
  if (scopeRunId === undefined) return plan;

  const candidates = originalRuns.filter((run) => run.parentRunId === scopeRunId);
  for (const node of walkNodes(tree.body)) {
    if (!RUN_PRODUCING_TYPES.has(node.type)) continue;
    const succeeded = candidates.filter((candidate) => candidate.nodeId === node.id && candidate.status === "succeeded");
    const [only] = succeeded;
    if (only && succeeded.length === 1) plan.set(node.id, only);
  }
  return plan;
}

// Re-derived here from the format so the reuse decisions below stay pure over `@path/schema` and this
// module never has to import the executor. The executor derives the same two types for its own use;
// both resolve to the same `WorkflowFile["body"]` member, so a call across the seam type-checks.
type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

/**
 * The original nested workflow-run a non-reused `workflow` node re-enters on resume (#172), or
 * undefined to start fresh. Matched by (parent run, node id) within the original tree:
 * `counterpartRunId` is the re-entering run's own original counterpart (the top-level call passes the
 * original root run id; the engine passes a re-entered nested run's counterpart when it recurses).
 * Exactly one match re-enters and restores; zero (a node added since) or more than one (a while-do
 * body's workflow step, one run per iteration — which to restore is undefined) both start fresh,
 * mirroring `planReuse`'s refusal to guess among multiple candidates. A node that *reused* never
 * reaches here: the executor short-circuits it before dispatch, so this only runs for a genuinely
 * re-entered run.
 */
export function findNestedCounterpart(
  originalRuns: RunRecord[],
  counterpartRunId: string | undefined,
  nodeId: string,
): RunRecord | undefined {
  if (counterpartRunId === undefined) return undefined;
  const matches = originalRuns.filter((r) => r.parentRunId === counterpartRunId && r.nodeId === nodeId);
  return matches.length === 1 ? matches[0] : undefined;
}

// True when every run-producing node in a branch already reuses a `succeeded` original run (#172) —
// i.e. this branch is the winner of an already-decided `wait-one` race being replayed. A branch with
// no run-producing node at all is not a decided winner (nothing was recorded to reuse), so it does
// not qualify. Losers were `cancelled`, never `succeeded`, so their nodes are absent from the plan
// and they fail this test — which is what lets resume start no loser (wait-one-join.md §7).
function branchIsReusedWinner(branch: ParallelBranch, plan: ReusePlan): boolean {
  let sawRunProducing = false;
  for (const inner of walkNodes([branch])) {
    if (RUN_PRODUCING_TYPES.has(inner.type)) {
      sawRunProducing = true;
      if (!plan.has(inner.id)) return false;
    }
  }
  return sawRunProducing;
}

// A fully-reused branch's recorded completion time: the latest `finishedAt` among its reused runs,
// since the branch reaches `succeeded` when its last node does. Null when no reused run carries a
// finish time — the tie-break below then falls back to declaration order.
function reusedBranchCompletion(branch: ParallelBranch, plan: ReusePlan): string | null {
  let completedAt: string | null = null;
  for (const inner of walkNodes([branch])) {
    if (RUN_PRODUCING_TYPES.has(inner.type)) {
      const record = plan.get(inner.id);
      const finishedAt = record?.finishedAt ?? null;
      if (finishedAt !== null && (completedAt === null || finishedAt > completedAt)) completedAt = finishedAt;
    }
  }
  return completedAt;
}

/**
 * The winner to reuse when replaying a decided `wait-one` race (wait-one-join.md §7). Usually exactly
 * one branch is a reused winner (the losers were `cancelled`, so absent from the plan), and it is
 * returned directly. Best-effort cancellation is asynchronous, though, so a photo-finish can leave
 * **two** branches recorded `succeeded`; the live run resolved that by `seq` (§6), the ordering truth
 * — which a `RunRecord` does not carry. Resume reproduces it from the recorded completion time (a
 * lower `seq` was emitted no later, so the branch that finished first is the recorded winner), and
 * declaration order breaks an exact timestamp collision — the case `seq` exists for but resume cannot
 * see. Picking the first-*declared* winner instead would land a different branch than the original
 * run's `join-applied` named, breaking resume determinism (ADR 0001).
 */
export function pickReusedWaitOneWinner(node: ParallelNode, plan: ReusePlan): ParallelBranch | undefined {
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
