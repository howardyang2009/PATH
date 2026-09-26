import {
  isPlainObject,
  type JsonValue,
  type RunStatus,
  type WorkflowFile,
  walkNodes,
} from "@path/schema";

/** The one awaiting leaf step type v1 ships (ADR 0039); the same string the Complete route gates on. */
export const AWAITING_STEP_TYPE = "person-activity";

/** The `person-activity` node's three type fields (CONTEXT.md § Person-activity), read from the workflow file to draw
 * the awaiting surface.
 */
export interface AwaitingNode {
  /** The instructions shown to the person **as authored**: the Viewer holds no config or context, so the server
   * interpolates at Complete time (ADR 0040).
   */
  description: string | null;
  /** The optional informational assignee label; no enforcement (CONTEXT.md). `null` when omitted. */
  assignee: string | null;
  /** The JSON Schema object the Complete form is built from; `null` means the node accepts any JSON output. */
  outputSchema: JsonValue | null;
}

/** The node with id `nodeId` in a **structurally-parsed** file, or `null`. The walk descends control blocks but not a
 * `workflow` step's ref'd file, so a leaf in a nested file reads as absent rather than invented.
 */
export function findAwaitingNode(file: WorkflowFile, nodeId: string): AwaitingNode | null {
  for (const node of walkNodes(file.body)) {
    if (node.id !== nodeId) continue;
    if ((node.type as string) !== AWAITING_STEP_TYPE) return null;
    const loose = node as unknown as {
      description?: unknown;
      assignee?: unknown;
      outputSchema?: unknown;
    };
    return {
      description: typeof loose.description === "string" ? loose.description : null,
      assignee: typeof loose.assignee === "string" ? loose.assignee : null,
      outputSchema: isPlainObject(loose.outputSchema) ? loose.outputSchema : null,
    };
  }
  return null;
}

/** The one guard the rail (`run-tree`) and the detail panel (`node-io`) both apply: `null` unless the run is
 * `awaiting`, a file holds the node id, and the node is still a `person-activity`. `files` may be the set of
 * reachable files; a hit of the wrong type reads as `null`.
 */
export function awaitingNodeForRun(
  files: WorkflowFile | readonly WorkflowFile[] | null,
  run: { status: RunStatus; nodeId: string | null },
): AwaitingNode | null {
  if (run.status !== "awaiting" || files === null || run.nodeId === null) return null;
  const list = Array.isArray(files) ? files : [files as WorkflowFile];
  for (const file of list) {
    const found = findAwaitingNode(file, run.nodeId);
    if (found) return found;
  }
  return null;
}
