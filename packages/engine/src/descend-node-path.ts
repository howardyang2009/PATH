import { serialOrder, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { resolveChildRef } from "./ref-tree.js";

/** Why a descent could not reach the next level of a node-id path. */
export type NodePathMiss =
  | "no-file-tree" // the caller supplied no loaded file map, so no `ref` can resolve
  | "node-missing" // the path-node id is not in this level's serial order
  | "not-workflow" // the path-node is present but is not a nested `workflow` node to descend into
  | "ref-unresolved"; // the `workflow` node's `ref` names a file not in the loaded tree

/** One level of a resolved node-id descent path (root→…→K): the file it lives in and the node it names. */
export interface NodePathLevel {
  file: WorkflowFile;
  /** That file's directory; this level's node `ref` resolves against it for the next level down. */
  dir: string;
  nodeId: string;
  /** The node with that id in this level's serial order, or `undefined` when the serial order no longer holds it. */
  node: WorkflowNode | undefined;
}

export interface NodePathDescent {
  levels: NodePathLevel[];
  /** Absent when the whole `nodePath` resolved; otherwise the level index the descent could not pass and why. */
  miss?: { atIndex: number; reason: NodePathMiss };
}

/**
 * Descend a node-id path root→…→K through the nested `workflow` file tree; returns every level reached
 * plus the `miss` that stopped it. Validates nothing about run status or locus.
 */
export function descendNodePath(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  nodePath: string[],
): NodePathDescent {
  const levels: NodePathLevel[] = [];
  let file: WorkflowFile = rootFile;
  let dir = rootDir;
  for (let index = 0; index < nodePath.length; index++) {
    const nodeId = nodePath[index]!;
    const node = serialOrder(file.body).find((n) => n.id === nodeId);
    levels.push({ file, dir, nodeId, node });

    if (index === nodePath.length - 1) break; // the leaf level needs no descent

    // Anything that blocks the descent ends it here with the reason; the caller renders its own message.
    if (node === undefined) return { levels, miss: { atIndex: index, reason: "node-missing" } };
    if (node.type !== "workflow")
      return { levels, miss: { atIndex: index, reason: "not-workflow" } };
    if (files === undefined) return { levels, miss: { atIndex: index, reason: "no-file-tree" } };
    const child = resolveChildRef(dir, node.ref, files);
    if (child === undefined) return { levels, miss: { atIndex: index, reason: "ref-unresolved" } };
    file = child.file;
    dir = child.dir;
  }
  return { levels };
}
