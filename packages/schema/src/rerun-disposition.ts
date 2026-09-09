import type { WorkflowNode } from "./node-type.js";

/**
 * The **disposition** of one top-level node under Resume-from-K (CONTEXT.md *Rerun boundary (K)*, ADR
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
 * Classify one top-level node of `body` against this level's `suffix`. An empty suffix is plain Resume
 * / off-path — every node reuses.
 *
 * The suffix head B must be a top-level node of `body`: `Project.resume` validates the whole path
 * against the current file before any successor starts (ADR 0036, spec §5), so a head absent here is an
 * internal-invariant violation, thrown rather than silently degraded — the same backstop the engine's
 * `suppress` producer carries. A `nodeId` that is not a top-level node degrades to `rerun-entire`
 * (re-run, never mis-reuse).
 */
export function rerunDisposition(body: WorkflowNode[], suffix: string[], nodeId: string): RerunDisposition {
  if (suffix.length === 0) return "reuse";
  const head = suffix[0]!;
  const bIndex = body.findIndex((node) => node.id === head);
  if (bIndex < 0) {
    throw new Error(`resume: rerun boundary node "${head}" is not a top-level node of the workflow`);
  }
  const nodeIndex = body.findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0 || nodeIndex > bIndex) return "rerun-entire"; // after B, or not a top-level node
  if (nodeIndex < bIndex) return "reuse"; // before B
  // nodeIndex === bIndex: the node is B itself — descend when an inner boundary follows, else K.
  return suffix.length > 1 ? "descend" : "rerun-entire";
}
