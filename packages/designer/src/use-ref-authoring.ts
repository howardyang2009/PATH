import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { useState } from "react";
import { replaceNode } from "./edit-target.js";
import { findById } from "./edit-tree.js";
import { relativeRefPath } from "./resolve-ref.js";
import type { OpenSession } from "./use-open-file.js";

/**
 * The nested-`workflow`-ref authoring flow: the in-flight node and its two transitions
 * (reference-existing, create-new) behind one handle the pane and the canvas both wire up.
 */

/** The chooser is offered only for a file that has a path — a ref is stored relative to the referring file. */
export interface RefAuthoring {
  /** Open the ref-target chooser for `nodeId`; `undefined` when the active file has no path to be relative to. */
  onAuthorRef?: (nodeId: string) => void;
  /** The node whose target is being chosen; `null` when the chooser is closed. */
  target: { nodeId: string; excludePath: string } | null;
  /** Point the in-flight node's `ref` at a discovered workflow, then close. */
  pickExisting: (targetPath: string) => void;
  createNew: () => void;
  cancel: () => void;
}

/**
 * Point `nodeId`'s `ref` at `targetPath`, relative to the referring file; `null` if the node is gone or not a
 * `workflow`.
 */
function fileWithNodeRef(
  file: WorkflowFile,
  activePath: string,
  nodeId: string,
  targetPath: string,
): WorkflowFile | null {
  const node = findById(file.body, nodeId);
  if (!node || node.type !== "workflow") return null;
  const ref = relativeRefPath(activePath, targetPath);
  return replaceNode(file, { ...node, ref } as WorkflowNode);
}

export function useRefAuthoring(
  session: OpenSession,
  openedFile: WorkflowFile | null,
  activePath: string | undefined,
): RefAuthoring {
  // The in-flight node id; `setNodeId` is stable, so the handle the pane and canvas receive is stable.
  const [nodeId, setNodeId] = useState<string | null>(null);
  const cancel = (): void => setNodeId(null);

  const pickExisting = (targetPath: string): void => {
    if (nodeId !== null && openedFile && activePath !== undefined) {
      const next = fileWithNodeRef(openedFile, activePath, nodeId, targetPath);
      if (next) session.applyEdit(next);
    }
    setNodeId(null);
  };

  // Descend into a fresh, unwritten child linked to this node; no path is chosen and no ref is set yet —
  // the child's first save picks the path and back-fills the parent ref, so the ref follows the save.
  const createNew = (): void => {
    if (nodeId !== null) session.descendNewUnbound(nodeId);
    setNodeId(null);
  };

  return {
    onAuthorRef: activePath === undefined ? undefined : setNodeId,
    target:
      nodeId !== null && activePath !== undefined ? { nodeId, excludePath: activePath } : null,
    pickExisting,
    createNew,
    cancel,
  };
}
