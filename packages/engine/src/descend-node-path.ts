import { dirname, resolve } from "node:path";
import type { WorkflowFile, WorkflowNode } from "@path/schema";

/** Why a descent could not reach the next level of a node-id path. */
export type NodePathMiss =
  | "no-file-tree" // the caller supplied no loaded file map, so no `ref` can resolve
  | "node-missing" // the path-node id is not a top-level node of this level's file
  | "not-workflow" // the path-node is present but is not a nested `workflow` node to descend into
  | "ref-unresolved"; // the `workflow` node's `ref` names a file not in the loaded tree

/** One level of a resolved node-id descent path (root→…→K): the file it lives in and the node it names. */
export interface NodePathLevel {
  /** This level's file — the root file at level 0, a descended nested `workflow`'s file below. */
  file: WorkflowFile;
  /** That file's directory; this level's node `ref` resolves against it for the next level down. */
  dir: string;
  /** This level's path-node id. */
  nodeId: string;
  /** The top-level node with that id in this level's file, or `undefined` when the file no longer holds it. */
  node: WorkflowNode | undefined;
}

/** The reached levels of a descent, plus the `miss` that stopped it short of the full path (if any). */
export interface NodePathDescent {
  /** Every level the descent reached, top-down. `levels[0]` is always the root file. */
  levels: NodePathLevel[];
  /** Absent when the whole `nodePath` resolved; otherwise the level index the descent could not pass and why. */
  miss?: { atIndex: number; reason: NodePathMiss };
}

/**
 * Descend a node-id path root→…→K through the nested `workflow` file tree — one shared primitive for
 * the descent the resume machinery used to re-code by hand. A rerun-boundary path (ADR 0036) and its
 * persisted name crumbs (#444) walk the *same* tree: resolve a level's `workflow` node `ref` against
 * that file's own dir, load the child file, repeat. `resolveLegalK` (the eager legality authority) and
 * `resolveRerunFromNodePath` (the crumb denormalization) are its two adapters; neither re-resolves a
 * `ref` any more.
 *
 * Eager and total: it returns every level it could reach plus the `miss` that stopped it, so a caller
 * reads levels and never re-walks. It descends only through a top-level `workflow` node whose `ref` is
 * in `files`; anything else ends the descent with the matching `miss` at that level's index. It
 * validates nothing about run status or locus — that is `classifyLevelK`'s job over each level's
 * `file.body`. It lives in the engine, not `@path/schema`, because `@path/schema` owns no filesystem
 * concern (not even path math); ref-relative resolution is the engine's.
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
    const node = file.body.find((n) => n.id === nodeId);
    levels.push({ file, dir, nodeId, node });

    if (index === nodePath.length - 1) break; // the leaf level needs no descent

    // Descend into this level's path-node for the next level's file. Anything that blocks the descent
    // ends it here with the reason; the caller renders its own message from `miss.reason`.
    if (node === undefined) return { levels, miss: { atIndex: index, reason: "node-missing" } };
    if (node.type !== "workflow") return { levels, miss: { atIndex: index, reason: "not-workflow" } };
    if (files === undefined) return { levels, miss: { atIndex: index, reason: "no-file-tree" } };
    const childPath = resolve(dir, node.ref);
    const childFile = files.get(childPath);
    if (childFile === undefined) return { levels, miss: { atIndex: index, reason: "ref-unresolved" } };
    file = childFile;
    dir = dirname(childPath);
  }
  return { levels };
}
