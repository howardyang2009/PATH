import { walkNodes, type JsonValue, type WorkflowFile } from "@path/schema";

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

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      outputSchema: isJsonObject(loose.outputSchema) ? loose.outputSchema : null,
    };
  }
  return null;
}
