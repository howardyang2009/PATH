/** A run and every log event is labelled by its node; the top-level workflow's implicit root step
 * has no node id, so a null `node_id` reads as "root" (CONTEXT.md, "Core execution model").
 */
export function nodeLabel(nodeId: string | null): string {
  return nodeId ?? "root";
}

/** The first 8 characters of a GUID: enough to tell rows apart at a glance; the full id stays the
 * wire value. */
export function shortGuid(guid: string): string {
  return guid.slice(0, 8);
}

/** A narrative row names its node by both the human `node_name` and the short GUID `node_id`; both
 * are nullable together for the implicit root step, which reads as "root", and a name-less row
 * falls back to the full id alone.
 */
export function nodeEventLabel(nodeId: string | null, nodeName: string | null | undefined): string {
  if (nodeName === null || nodeName === undefined) return nodeLabel(nodeId);
  return nodeId === null ? nodeName : `${nodeName} (${shortGuid(nodeId)})`;
}
