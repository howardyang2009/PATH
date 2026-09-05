import { useState } from "react";
import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { findById, replaceNode } from "./edit-tree.js";
import { relativeRefPath } from "./resolve-ref.js";
import type { OpenSession } from "./use-open-file.js";

/**
 * The nested-`workflow`-ref authoring flow (#391), gathered out of `App` into one seam. Authoring a ref is
 * one user story, but its state and logic used to spread thin across the App: the in-flight node id, a
 * relative-ref computation, an `applyEdit`, and a `descendNewUnbound` sat beside the unrelated authoring
 * state, and the flow's tail reached into `use-open-file`. Two surfaces *enter* it — the pane's "Choose a
 * reference target…" and the canvas's double-click on an unset `workflow` block — so tracing "what happens
 * when I add a ref target" meant walking five files.
 *
 * Here the node-in-flight state and the two transitions (reference-existing, create-new) live behind one
 * hook. The App wires the single `onAuthorRef` handle onto both surfaces and renders the chooser from
 * `target`; the relative-ref rule and the descent sit next to each other, where a bug in one is visible
 * from the other.
 */

/** The chooser is offered only for a file that has a path — a ref is stored relative to the referring file. */
export interface RefAuthoring {
  /**
   * Open the ref-target chooser for the empty `workflow` node `nodeId`. `undefined` when the active file has
   * no path (a from-scratch root), so a ref has no directory to be relative to — the pane and canvas then
   * fall back to their plain path field / inert double-click.
   */
  onAuthorRef?: (nodeId: string) => void;
  /** The node whose target is being chosen, with the parent path to exclude from the picker; `null` when closed. */
  target: { nodeId: string; excludePath: string } | null;
  /** Reference-existing: point the in-flight node's `ref` at a discovered workflow, then close. */
  pickExisting: (targetPath: string) => void;
  /** Create-new: descend at once into a fresh, unwritten, path-less child linked back to the node, then close. */
  createNew: () => void;
  /** Close the chooser without a choice. */
  cancel: () => void;
}

/**
 * Set the empty `workflow` node's `ref` to reach `targetPath`. The stored ref is relative to the referring
 * file's directory (`relativeRefPath`), so this needs the parent's path — the chooser is only offered when
 * the active file has one. Returns the edited file, or `null` if the node is gone or not a `workflow`.
 */
function fileWithNodeRef(file: WorkflowFile, activePath: string, nodeId: string, targetPath: string): WorkflowFile | null {
  const node = findById(file.body, nodeId);
  if (!node || node.type !== "workflow") return null;
  const ref = relativeRefPath(activePath, targetPath);
  return replaceNode(file, nodeId, { ...node, ref } as WorkflowNode);
}

export function useRefAuthoring(session: OpenSession, openedFile: WorkflowFile | null, activePath: string | undefined): RefAuthoring {
  // The id of the empty `workflow` node whose target is being chosen, or `null`. `setNodeId` is stable, so
  // the `onAuthorRef` handle the pane and canvas receive is stable while the active file keeps a path.
  const [nodeId, setNodeId] = useState<string | null>(null);
  const cancel = (): void => setNodeId(null);

  // Reference-existing: point the ref at a discovered workflow and close.
  const pickExisting = (targetPath: string): void => {
    if (nodeId !== null && openedFile && activePath !== undefined) {
      const next = fileWithNodeRef(openedFile, activePath, nodeId, targetPath);
      if (next) session.applyEdit(next);
    }
    setNodeId(null);
  };

  // Create-new: descend at once into a fresh, unwritten, path-less child linked back to this node. No path is
  // chosen here and no ref is set yet — the child's first save picks the path and back-fills the parent ref
  // from it, so authoring comes first and the ref follows the save.
  const createNew = (): void => {
    if (nodeId !== null) session.descendNewUnbound(nodeId);
    setNodeId(null);
  };

  return {
    onAuthorRef: activePath === undefined ? undefined : setNodeId,
    target: nodeId !== null && activePath !== undefined ? { nodeId, excludePath: activePath } : null,
    pickExisting,
    createNew,
    cancel,
  };
}
