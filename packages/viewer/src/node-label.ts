/**
 * A run, and every log event, is labelled by the node it belongs to. The top-level workflow is
 * wrapped in an implicit root step with no node id of its own (CONTEXT.md, "Core execution model"),
 * so a null `node_id` reads as the root rather than as a blank. Shared by the run tree and the
 * narrative so the same run is named the same way in both.
 */
export function nodeLabel(nodeId: string | null): string {
  return nodeId ?? "root";
}

/**
 * A narrative row names its node by both the human `node_name` and the GUID `node_id`, so a watcher
 * reading the log gets the readable name without losing the id that ties the row back to its run.
 * The two are nullable together — the implicit root step has neither (CONTEXT.md, "Core execution
 * model") — and that case reads as "root", same as `nodeLabel`. A name-less node (a hand-written
 * row) falls back to the id alone.
 */
export function nodeEventLabel(nodeId: string | null, nodeName: string | null | undefined): string {
  if (nodeName === null || nodeName === undefined) return nodeLabel(nodeId);
  return nodeId === null ? nodeName : `${nodeName} (${nodeId})`;
}
