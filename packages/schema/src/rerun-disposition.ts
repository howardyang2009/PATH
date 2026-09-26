import type { WorkflowNode } from "./node-type.js";
import { serialOrder } from "./node-walk.js";

/**
 * The **disposition** of one serial-order node under Resume-from-K (CONTEXT.md *Rerun boundary (K)*, ADR
 * 0036): what a resuming workflow-run does with a node of its own body, given this level's remaining
 * root→…→K descent path (`suffix`, whose head is this level's path-node **B**).
 *
 * - **reuse** — the node is before B, or this level is off-path / plain Resume (empty suffix): its
 *   succeeded original run is reused by id (`planReuse`).
 * - **descend** — the node *is* B and B is an intermediate path-node (a longer tail follows): it is
 *   re-entered against its counterpart and applies the next level's boundary (`suffix.slice(1)`).
 * - **rerun-entire** — the node is B == K (a leaf boundary), or it is after B: no reuse, no
 *   counterpart, its whole subtree re-runs.
 *
 * The one authority for the three-way verdict the resume readers used to each re-derive — the descent
 * site from overlapping `suppress`/`rerunEntire` sets, the loop from raw `findIndex` math. Producer A
 * (the engine's `suppress` set, ADR 0035) stays the reuse-plan *mechanism*; this names the verdict that
 * set implies, so `childResumeState` and `loopIterationResume` read one function instead of restating
 * the "at / after / before B" rule.
 *
 * It classifies at the grain of **one body against one suffix**, the same grain as `classifyLevelK`.
 */
export type RerunDisposition = "reuse" | "descend" | "rerun-entire";

/**
 * The rerun boundary's position in one body: the index of `suffix`'s head **B**, or `undefined` when
 * the suffix is empty (plain Resume / off-path, so there is no boundary at this level).
 *
 * The one statement of "where is B here", which the verdict below and the engine's `suppress` producer
 * (ADR 0035's Producer A) both used to compute — each with its own `findIndex` and its own copy of the
 * invariant throw. The index is into the body's serial order (`serialOrder`, ADR 0064: a sequence body is
 * transparent). The head is **known** to be in that order by the time either reader runs:
 * `Project.resume` validates the whole root→…→K path against the current file before any successor
 * starts (ADR 0036, spec §5). A head absent here is therefore an internal-invariant violation, thrown
 * rather than silently degraded — never "no boundary", which would reuse the very work the operator
 * asked to drop.
 */
export function rerunBoundaryIndex(
  body: WorkflowNode[],
  suffix: readonly string[],
): number | undefined {
  if (suffix.length === 0) return undefined;
  const head = suffix[0]!;
  const index = serialOrder(body).findIndex((node) => node.id === head);
  if (index < 0) {
    throw new Error(
      `resume: rerun boundary node "${head}" is not a top-level node of the workflow`,
    );
  }
  return index;
}

/**
 * Classify one node of `body`'s serial order against this level's `suffix`. An empty suffix is plain Resume
 * / off-path — every node reuses.
 *
 * A `nodeId` that is not in the serial order degrades to `rerun-entire` (re-run, never mis-reuse).
 */
export function rerunDisposition(
  body: WorkflowNode[],
  suffix: string[],
  nodeId: string,
): RerunDisposition {
  const bIndex = rerunBoundaryIndex(body, suffix);
  if (bIndex === undefined) return "reuse";
  const nodeIndex = serialOrder(body).findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0 || nodeIndex > bIndex) return "rerun-entire"; // after B, or not in the serial order
  if (nodeIndex < bIndex) return "reuse"; // before B
  // nodeIndex === bIndex: the node is B itself — descend when an inner boundary follows, else K.
  return suffix.length > 1 ? "descend" : "rerun-entire";
}
