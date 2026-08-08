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
