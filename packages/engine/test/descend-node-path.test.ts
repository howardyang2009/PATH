import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowFile } from "@path/schema";
import { descendNodePath } from "../src/descend-node-path.js";

// Minimal files: descendNodePath reads only `body`, and a path-node's `type`/`id`/`ref`.
const step = (id: string) => ({ type: "binary", id, name: id, command: "node", args: ["-e", ""] });
const wf = (id: string, ref: string) => ({ type: "workflow", id, name: id, ref });
const file = (id: string, body: unknown[]): WorkflowFile => ({ version: "path/workflow@2", id, name: id, body } as unknown as WorkflowFile);

const rootDir = "/wf";
const childPath = resolve(rootDir, "./child.workflow.json");

// root: [a, w(→child)]; child: [k]
const root = file("root", [step("a"), wf("w", "./child.workflow.json")]);
const child = file("child", [step("k")]);
const files = new Map<string, WorkflowFile>([[childPath, child]]);

describe("descendNodePath", () => {
  it("resolves a single top-level level with no descent", () => {
    const { levels, miss } = descendNodePath(root, rootDir, files, ["a"]);
    expect(miss).toBeUndefined();
    expect(levels).toHaveLength(1);
    expect(levels[0]!.file).toBe(root);
    expect(levels[0]!.node?.id).toBe("a");
  });

  it("descends a workflow ref into the child file's own body", () => {
    const { levels, miss } = descendNodePath(root, rootDir, files, ["w", "k"]);
    expect(miss).toBeUndefined();
    expect(levels).toHaveLength(2);
    expect(levels[0]!.file).toBe(root);
    expect(levels[1]!.file).toBe(child);
    expect(levels[1]!.node?.id).toBe("k");
  });

  it("misses node-missing when a path-node id is absent at its level", () => {
    const { levels, miss } = descendNodePath(root, rootDir, files, ["nope", "k"]);
    expect(miss).toEqual({ atIndex: 0, reason: "node-missing" });
    expect(levels).toHaveLength(1);
    expect(levels[0]!.node).toBeUndefined();
  });

  it("misses not-workflow when an intermediate path-node is not a nested workflow", () => {
    const { miss } = descendNodePath(root, rootDir, files, ["a", "k"]);
    expect(miss).toEqual({ atIndex: 0, reason: "not-workflow" });
  });

  it("misses ref-unresolved when the workflow ref is not in the loaded tree", () => {
    const { miss } = descendNodePath(root, rootDir, new Map(), ["w", "k"]);
    expect(miss).toEqual({ atIndex: 0, reason: "ref-unresolved" });
  });

  it("misses no-file-tree when descent is needed but no file map was supplied", () => {
    const { miss } = descendNodePath(root, rootDir, undefined, ["w", "k"]);
    expect(miss).toEqual({ atIndex: 0, reason: "no-file-tree" });
  });
});
