import type { WorkflowSummary } from "@path/schema";
import { describe, expect, it } from "vitest";
import {
  buildWorkflowTree,
  countWorkflowLeaves,
  isFolderOnOpenChain,
  nextOpenFolder,
  parentFolderPath,
  type WorkflowTreeFolder,
  type WorkflowTreeNode,
  workflowBaseName,
} from "../src/workflow-tree.js";

/** A discovery row where only `relative_path` steers the tree; the rest is filled to a valid
 * shape. */
function wf(relativePath: string, origin: WorkflowSummary["origin"] = "user"): WorkflowSummary {
  return {
    relative_path: relativePath,
    origin,
    id: null,
    name: null,
    valid: true,
    is_root: true,
    error: null,
  };
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

/** The children of the one origin folder a user-only tree has. */
function mine(tree: WorkflowTreeNode[]): WorkflowTreeNode[] {
  expect(tree).toHaveLength(1);
  const top = folder(tree[0]!);
  expect(top).toMatchObject({ name: "mine", path: "mine" });
  return top.children;
}

describe("buildWorkflowTree", () => {
  it("puts each origin in its own top folder, below its authored root", () => {
    const tree = buildWorkflowTree([
      wf("users/local/workflow/a.workflow.json"),
      wf("shared/workflow/team/b.workflow.json", "shared"),
    ]);

    expect(tree.map((n) => folder(n).name)).toEqual(["mine", "shared"]);
    expect(folder(tree[0]!).children).toMatchObject([{ kind: "file" }]);
    const team = folder(folder(tree[1]!).children[0]!);
    expect(team).toMatchObject({ name: "team", path: "shared/team" });
  });

  it("groups nested files under their folders and keeps top-level files at the origin folder", () => {
    const tree = mine(
      buildWorkflowTree([
        wf("users/local/workflow/lib/draft.workflow.json"),
        wf("users/local/workflow/release.workflow.json"),
      ]),
    );

    // Folders sort before files at each level.
    expect(tree.map((n) => n.kind)).toEqual(["folder", "file"]);
    const lib = folder(tree[0]!);
    expect(lib.name).toBe("lib");
    expect(lib.path).toBe("mine/lib");
    expect(lib.children).toHaveLength(1);
    expect(lib.children[0]).toMatchObject({ kind: "file" });
  });

  it("sorts each level folders-first then files, alphabetically", () => {
    const tree = mine(
      buildWorkflowTree([
        wf("beta.workflow.json"),
        wf("alpha.workflow.json"),
        wf("zeta/one.workflow.json"),
        wf("alpha-dir/one.workflow.json"),
      ]),
    );
    // alpha-dir + zeta (folders) come first, alpha + beta (files) after — each group alphabetical.
    expect(
      tree.map((n) => (n.kind === "folder" ? n.name : workflowBaseName(n.workflow.relative_path))),
    ).toEqual(["alpha-dir", "zeta", "alpha.workflow.json", "beta.workflow.json"]);
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
