import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowFile } from "@path/schema";
import { resolveChildRef, resolveNode, walkRefTree } from "../src/ref-tree.js";

/**
 * The loaded ref tree's one walk (#architecture-deepening): `walkRefTree` and `resolveChildRef` are
 * what the run-start config gate, `resolveNode`, the nested-run dispatch and the Rerun-boundary
 * descent share, so these tests pin the rules those four used to spell for themselves — the ref
 * resolving against *its own* level's dir, and the effective config threading across the file seam.
 */

const ROOT_DIR = "/proj";
const CHILD_REF = "sub/child.workflow.json";
const CHILD_PATH = join(ROOT_DIR, "sub", "child.workflow.json");

/** The nested file, with a `$env` value so the env the walk is handed — not `process.env` — is what it reads. */
const child: WorkflowFile = {
  format: "path/workflow@5",
  id: "child-id",
  name: "child",
  config: { childOnly: "from-child-file" },
  body: [
    {
      type: "binary",
      id: "child-step",
      name: "child-step",
      command: "echo",
      config: { childNode: "from-child-node", fromEnv: { $env: "REF_TREE_TEST_VAR" } },
    },
  ],
};

/** The root: a plain step, then a `workflow` step whose own config must reach the child's nodes. */
const root: WorkflowFile = {
  format: "path/workflow@5",
  id: "root-id",
  name: "root",
  config: { fileShared: "from-root-file" },
  body: [
    { type: "binary", id: "root-step", name: "root-step", command: "echo", config: { rootNode: "from-root-node" } },
    { type: "workflow", id: "ref-node", name: "ref-node", ref: CHILD_REF, config: { refStep: "from-ref-step" } },
  ],
};

const files = new Map([[CHILD_PATH, child]]);
const env = { REF_TREE_TEST_VAR: "resolved-from-env" };

describe("walkRefTree", () => {
  it("yields the root's nodes and then the ref'd file's, threading effective config across the seam", () => {
    const entries = [...walkRefTree(root, ROOT_DIR, { files, operatorConfig: { fromOperator: "operator" }, env })];

    expect(entries.map((entry) => entry.node.id)).toEqual(["root-step", "ref-node", "child-step"]);
    expect(entries.map((entry) => entry.dir)).toEqual([ROOT_DIR, ROOT_DIR, join(ROOT_DIR, "sub")]);

    // The root step: operator override over the file's config over the node's own fragment.
    expect(entries[0]!.stepConfig).toEqual({
      fromOperator: "operator",
      fileShared: "from-root-file",
      rootNode: "from-root-node",
    });

    // The child step inherits the ref step's effective config, then its own file's and its own node's —
    // and its `$env` resolves against the env the walk was handed, not the ambient process env.
    expect(entries[2]!.stepConfig).toEqual({
      fromOperator: "operator",
      fileShared: "from-root-file",
      refStep: "from-ref-step",
      childOnly: "from-child-file",
      childNode: "from-child-node",
      fromEnv: "resolved-from-env",
    });
    expect(entries[2]!.file).toBe(child);
  });

  it("visits a file once per incoming config when two refs reach it", () => {
    const twice: WorkflowFile = {
      ...root,
      body: [
        { type: "workflow", id: "ref-a", name: "ref-a", ref: CHILD_REF, config: { branch: "a" } },
        { type: "workflow", id: "ref-b", name: "ref-b", ref: CHILD_REF, config: { branch: "b" } },
      ],
    };

    const reached = [...walkRefTree(twice, ROOT_DIR, { files, env })].filter((entry) => entry.node.id === "child-step");

    expect(reached).toHaveLength(2);
    expect(reached.map((entry) => entry.stepConfig.branch)).toEqual(["a", "b"]);
  });

  it("stops at the ref when no loaded tree is supplied", () => {
    const ids = [...walkRefTree(root, ROOT_DIR, { env })].map((entry) => entry.node.id);

    expect(ids).toEqual(["root-step", "ref-node"]);
  });
});

describe("resolveChildRef", () => {
  it("resolves a ref against the level's own dir and carries the child's own dir", () => {
    expect(resolveChildRef(ROOT_DIR, CHILD_REF, files)).toEqual({ file: child, dir: join(ROOT_DIR, "sub") });
  });

  it("is undefined for an absent file or an absent tree", () => {
    expect(resolveChildRef(ROOT_DIR, "nope.workflow.json", files)).toBeUndefined();
    expect(resolveChildRef(ROOT_DIR, CHILD_REF, undefined)).toBeUndefined();
  });
});

describe("resolveNode", () => {
  it("finds a node in a nested file with the effective config that reaches it", () => {
    const resolved = resolveNode(root, ROOT_DIR, "child-step", { files, operatorConfig: { fromOperator: "operator" }, env });

    expect(resolved?.node.id).toBe("child-step");
    expect(resolved?.config).toMatchObject({
      fromOperator: "operator",
      fileShared: "from-root-file",
      refStep: "from-ref-step",
      childOnly: "from-child-file",
      childNode: "from-child-node",
    });
  });

  it("reads the env it is handed, not the ambient one, so a caller can pass the Run's snapshot", () => {
    const resolved = resolveNode(root, ROOT_DIR, "child-step", { files, env: { REF_TREE_TEST_VAR: "run-snapshot" } });

    expect(resolved?.config.fromEnv).toBe("run-snapshot");
  });

  it("is undefined for a node id no reachable file holds", () => {
    expect(resolveNode(root, ROOT_DIR, "ghost", { files, env })).toBeUndefined();
  });
});
