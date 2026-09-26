// The folder tree behind every workflow picker: `GET /v0/workflows` returns a flat list, and each
// `relative_path` is a real filesystem path, so a nested workflow lives inside its folders. A level
// shows only its own children; folders open one per level as an accordion.

import type { WorkflowSummary } from "@path/schema";

/** A folder node: a navigation step that groups the workflows (and folders) under one path prefix. */
export interface WorkflowTreeFolder {
  kind: "folder";
  /** The last path segment — the visible folder name. */
  name: string;
  /** The full path prefix from the root, e.g. `lib/drafts` — the folder's identity and open-state key. */
  path: string;
  children: WorkflowTreeNode[];
}

/** A leaf node: one discovered workflow file. */
export interface WorkflowTreeLeaf {
  kind: "file";
  workflow: WorkflowSummary;
}

export type WorkflowTreeNode = WorkflowTreeFolder | WorkflowTreeLeaf;

/** The file name of a workflow path — the leaf's own line, since its folders already sit above it. */
export function workflowBaseName(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? relativePath : relativePath.slice(slash + 1);
}

/** The parent-folder path of a folder path, or `null` at the top level. */
export function parentFolderPath(path: string): string | null {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? null : path.slice(0, slash);
}

/** Group flat workflow summaries into a folder tree by splitting each `relative_path` on `/`. */
export function buildWorkflowTree(workflows: readonly WorkflowSummary[]): WorkflowTreeNode[] {
  const root: WorkflowTreeFolder = { kind: "folder", name: "", path: "", children: [] };
  for (const workflow of workflows) {
    const segments = workflow.relative_path.split("/");
    segments.pop(); // the file name — the leaf, not a folder
    let cursor = root;
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let folder = cursor.children.find(
        (child): child is WorkflowTreeFolder => child.kind === "folder" && child.name === segment,
      );
      if (!folder) {
        folder = { kind: "folder", name: segment, path: prefix, children: [] };
        cursor.children.push(folder);
      }
      cursor = folder;
    }
    cursor.children.push({ kind: "file", workflow });
  }
  sortLevel(root);
  return root.children;
}

/** Order each level folders-first, then files, each group alphabetical — recursively. */
function sortLevel(folder: WorkflowTreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const an = a.kind === "folder" ? a.name : workflowBaseName(a.workflow.relative_path);
    const bn = b.kind === "folder" ? b.name : workflowBaseName(b.workflow.relative_path);
    return an.localeCompare(bn);
  });
  for (const child of folder.children) if (child.kind === "folder") sortLevel(child);
}

/** The number of workflow files anywhere under a folder — the count shown on its row. */
export function countWorkflowLeaves(folder: WorkflowTreeFolder): number {
  return folder.children.reduce(
    (sum, child) => sum + (child.kind === "folder" ? countWorkflowLeaves(child) : 1),
    0,
  );
}

/** Accordion open-state: a folder is expanded when `openFolder` is it or a prefix of it, so one folder
 * stays open per level. {@link nextOpenFolder} toggles: a click on the open chain walks back to its
 * parent, any other opens the clicked folder. */
export function isFolderOnOpenChain(openFolder: string | null, folderPath: string): boolean {
  return openFolder === folderPath || (openFolder?.startsWith(`${folderPath}/`) ?? false);
}

export function nextOpenFolder(openFolder: string | null, folderPath: string): string | null {
  return isFolderOnOpenChain(openFolder, folderPath) ? parentFolderPath(folderPath) : folderPath;
}
