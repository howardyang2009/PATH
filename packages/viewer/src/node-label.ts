/**
 * A run, and every log event, is labelled by the node it belongs to. The top-level workflow is
 * wrapped in an implicit root step with no node id of its own (CONTEXT.md, "Core execution model"),
 * so a null `node_id` reads as the root rather than as a blank. Shared by the run tree and the
 * narrative so the same run is named the same way in both.
 */
export function nodeLabel(nodeId: string | null): string {
  return nodeId ?? "root";
}
