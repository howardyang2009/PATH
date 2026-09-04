import { describe, expect, it } from "vitest";
import {
  buildWorkflowTree,
  countWorkflowLeaves,
  isFolderOnOpenChain,
  nextOpenFolder,
  parentFolderPath,
  workflowBaseName,
  type WorkflowTreeFolder,
  type WorkflowTreeNode,
} from "../src/workflow-tree.js";
import type { WorkflowSummary } from "@path/schema";

/** A discovery row where only `relative_path` steers the tree; the rest is filled to a valid shape. */
function wf(relativePath: string): WorkflowSummary {
  return { relative_path: relativePath, id: null, name: null, valid: true, is_root: true, error: null };
}

/** Narrow a node to a folder for assertions, failing loudly if it is a file. */
function folder(node: WorkflowTreeNode): WorkflowTreeFolder {
  if (node.kind !== "folder") throw new Error(`expected a folder, got ${node.kind}`);
  return node;
}

describe("workflowBaseName / parentFolderPath", () => {
  it("splits the last path segment from the rest", () => {
    expect(workflowBaseName("lib/drafts/a.workflow.json")).toBe("a.workflow.json");
    expect(workflowBaseName("a.workflow.json")).toBe("a.workflow.json");
    expect(parentFolderPath("lib/drafts")).toBe("lib");
    expect(parentFolderPath("lib")).toBeNull();
  });
});

describe("buildWorkflowTree", () => {
  it("groups nested files under their folders and keeps top-level files at the root", () => {
    const tree = buildWorkflowTree([wf("lib/draft.workflow.json"), wf("release.workflow.json")]);

    // Folders sort before files at each level.
    expect(tree.map((n) => n.kind)).toEqual(["folder", "file"]);
    const lib = folder(tree[0]!);
    expect(lib.name).toBe("lib");
    expect(lib.path).toBe("lib");
    expect(lib.children).toHaveLength(1);
    expect(lib.children[0]).toMatchObject({ kind: "file" });
  });

  it("sorts each level folders-first then files, alphabetically", () => {
    const tree = buildWorkflowTree([
      wf("beta.workflow.json"),
      wf("alpha.workflow.json"),
      wf("zeta/one.workflow.json"),
      wf("alpha-dir/one.workflow.json"),
    ]);
    // alpha-dir + zeta (folders) come first, alpha + beta (files) after — each group alphabetical.
    expect(tree.map((n) => (n.kind === "folder" ? n.name : workflowBaseName(n.workflow.relative_path)))).toEqual([
      "alpha-dir",
      "zeta",
      "alpha.workflow.json",
      "beta.workflow.json",
    ]);
  });

  it("counts every workflow under a folder, however deep", () => {
    const tree = buildWorkflowTree([
      wf("a/x.workflow.json"),
      wf("a/b/y.workflow.json"),
      wf("a/b/z.workflow.json"),
    ]);
    expect(countWorkflowLeaves(folder(tree[0]!))).toBe(3);
  });
});

describe("accordion open-state", () => {
  it("treats a folder as open when it is the open path or a prefix of it", () => {
    expect(isFolderOnOpenChain("a/b", "a")).toBe(true);
    expect(isFolderOnOpenChain("a/b", "a/b")).toBe(true);
    expect(isFolderOnOpenChain("a/b", "a/c")).toBe(false);
    expect(isFolderOnOpenChain(null, "a")).toBe(false);
  });

  it("opens a closed folder, and toggling an open folder walks back to its parent", () => {
    // Opening a sibling replaces the open path (accordion, one open per level).
    expect(nextOpenFolder("alpha", "beta")).toBe("beta");
    // Opening a child extends the chain; the parent stays open.
    expect(nextOpenFolder("a", "a/b")).toBe("a/b");
    // Toggling the open leaf collapses it back to its parent.
    expect(nextOpenFolder("a/b", "a/b")).toBe("a");
    // Toggling a folder on the chain collapses it and everything under it.
    expect(nextOpenFolder("a/b", "a")).toBeNull();
    // Toggling a top-level open folder collapses to nothing.
    expect(nextOpenFolder("a", "a")).toBeNull();
  });
});
