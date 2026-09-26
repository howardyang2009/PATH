import type { WorkflowNode } from "./node-type.js";
import { serialOrder } from "./node-walk.js";

/**
 * How a resuming run treats one node under Resume-from-K (ADR 0036): **reuse** before B or off-path, **descend**
 * into an intermediate B, **rerun-entire** otherwise.
 */
export type RerunDisposition = "reuse" | "descend" | "rerun-entire";

/** Index of `suffix`'s head B in the body's serial order, or `undefined` when the suffix is empty. An
 * absent head throws, since "no boundary" would reuse the work the operator asked to drop. */
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
 * Classify one node of `body`'s serial order against this level's `suffix`; an empty suffix reuses every node, and a
 * `nodeId` outside the order degrades to rerun-entire.
 */
export function rerunDisposition(
  body: WorkflowNode[],
  suffix: string[],
  nodeId: string,
): RerunDisposition {
  const bIndex = rerunBoundaryIndex(body, suffix);
  if (bIndex === undefined) return "reuse";
  const nodeIndex = serialOrder(body).findIndex((node) => node.id === nodeId);
  if (nodeIndex < 0 || nodeIndex > bIndex) return "rerun-entire";
  if (nodeIndex < bIndex) return "reuse";
  return suffix.length > 1 ? "descend" : "rerun-entire";
}
