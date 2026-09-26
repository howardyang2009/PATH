import { isPlainObject, walkNodes, type JsonValue, type RunStatus, type WorkflowFile } from "@path/schema";

/**
 * The one awaiting leaf step type v1 ships (ADR 0039). A leaf is completable only while its node is
 * still of this type; the same string the Complete route (`complete-run.ts`) gates on.
 */
export const AWAITING_STEP_TYPE = "person-activity";

/**
 * The `person-activity` node's three type fields (CONTEXT.md § Person-activity), as the Viewer reads
 * them from the workflow file to draw the awaiting surface: the `description` callout, the assignee
 * chip, and the Complete form (built from `outputSchema`). They live in the file, never on the run row
 * — the run tree carries only the node **id**, so the surface resolves the rest here.
 */
export interface AwaitingNode {
  /**
   * The instructions shown to the person. Interpolable (`{{…}}`), but shown **as authored**: the
   * Viewer holds neither the run's config nor its context, so it never resolves the placeholders — the
   * server does, at Complete time, against the current file (ADR 0040). `null` only for a malformed
   * node missing its required `description`.
   */
  description: string | null;
  /** The optional informational assignee label; no enforcement (CONTEXT.md). `null` when omitted. */
  assignee: string | null;
  /**
   * The optional JSON Schema **object** the Complete form is built from; `null` means the node accepts
   * any JSON output (the server's "no schema" case). A present-but-non-object value is normalised to
   * `null` — an author error the server would reject, not a form this surface can lay out.
   */
  outputSchema: JsonValue | null;
}

/**
 * The `person-activity` node with id `nodeId` in a **structurally-parsed** workflow file, or `null`
 * when the id is absent or maps to another node type. `person-activity` is a plugin leaf outside the
 * core node union, so its fields are read loosely off the raw node.
 *
 * The walk descends control blocks (`walkNodes`) but not a `workflow` step's ref'd file — that file
 * has its own isolated context (`childBodies`). A leaf living in a nested file therefore reads as
 * absent here; the surface degrades to the schema-less form rather than inventing a node it cannot see.
 */
export function findAwaitingNode(file: WorkflowFile, nodeId: string): AwaitingNode | null {
  for (const node of walkNodes(file.body)) {
    if (node.id !== nodeId) continue;
    if ((node.type as string) !== AWAITING_STEP_TYPE) return null;
    const loose = node as unknown as { description?: unknown; assignee?: unknown; outputSchema?: unknown };
    return {
      description: typeof loose.description === "string" ? loose.description : null,
      assignee: typeof loose.assignee === "string" ? loose.assignee : null,
      outputSchema: isPlainObject(loose.outputSchema) ? loose.outputSchema : null,
    };
  }
  return null;
}

/**
 * The awaiting node for a run, or `null` — the one guard both the rail (`run-tree`) and the detail
 * panel (`node-io`) apply, so the triple condition (leaf is `awaiting`, a file holds the node, the run
 * names a node) lives in one place. A run that is not `awaiting`, no file loaded, or a row with no
 * node id (the implicit root run) all resolve to `null` without a walk.
 *
 * `files` is one file or **the set of reachable files** — the root file and every workflow file its
 * `workflow` steps ref, transitively (`loadReachableWorkflowFiles`). A `person-activity` leaf can live
 * in a nested file, not only the root (issue #486 follow-up); node ids are durable GUIDs unique across
 * the tree (ADR 0007), so the node is found by scanning each file's own body — no cross-file config
 * descent is needed here, since `description`/`assignee`/`outputSchema` are shown **as authored** (the
 * server interpolates at Complete time, ADR 0040). The first file whose body holds the id decides it: a
 * hit of the wrong type reads as `null` (a retyped node degrades to the schema-less submit), and every
 * other file lacks the id and contributes nothing.
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
