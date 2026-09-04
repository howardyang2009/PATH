import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@path/schema";
import {
  configString,
  dropNodeKey,
  mergeNodePayload,
  nodeConfigOf,
  nodePayload,
  setNodeField,
  withConfig,
  withOptionalArray,
  withOptionalString,
} from "../src/node-edit.js";

/**
 * The pure node-content algebra behind the properties pane (#369). These tests hit the bug-prone
 * invariants directly — dropping an emptied `config`, the envelope/payload split — where before they
 * were reachable only through a JSDOM render of the pane.
 */

/** A minimal `binary` leaf for the transforms to act on (cast once; the union carries no index signature). */
function binaryNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return { id: "n1", name: "step", type: "binary", command: "echo", ...extra } as unknown as WorkflowNode;
}

/** Read a result node as an open record — the union has no index signature, so a test read casts through `unknown`. */
function asRec(node: WorkflowNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
}

describe("nodePayload / mergeNodePayload", () => {
  it("nodePayload returns only the non-envelope keys", () => {
    const node = binaryNode({ command: "echo", args: ["hi"], config: { model: "x" }, publish: { out: "${output.x}" } });
    expect(nodePayload(node)).toEqual({ command: "echo", args: ["hi"] });
  });

  it("mergeNodePayload keeps the envelope and never lets a payload leak an envelope key", () => {
    const node = binaryNode({ command: "echo", config: { model: "x" } });
    // The payload tries to smuggle in `id` and `config` (envelope keys) — both must be ignored.
    const next = mergeNodePayload(node, { command: "run", args: ["a"], id: "hacked", config: { model: "y" } });
    expect(next).toEqual({ id: "n1", name: "step", type: "binary", config: { model: "x" }, command: "run", args: ["a"] });
  });

  it("round-trips: mergeNodePayload(node, nodePayload(node)) is the same node", () => {
    const node = binaryNode({ command: "echo", args: ["a", "b"], config: { model: "x" } });
    expect(mergeNodePayload(node, nodePayload(node))).toEqual(node);
  });
});

describe("setNodeField / dropNodeKey", () => {
  it("setNodeField with undefined drops the key", () => {
    const node = binaryNode({ cwd: "/tmp" });
    expect("cwd" in asRec(setNodeField(node, "cwd", undefined))).toBe(false);
  });

  it("dropNodeKey removes exactly the one key", () => {
    const node = binaryNode({ cwd: "/tmp", args: ["x"] });
    const next = asRec(dropNodeKey(node, "cwd"));
    expect(next.cwd).toBeUndefined();
    expect(next.args).toEqual(["x"]);
  });
});

describe("withOptionalString / withOptionalArray", () => {
  it("drops the key when the value is empty, sets it otherwise", () => {
    const node = binaryNode({ cwd: "/tmp" });
    expect("cwd" in asRec(withOptionalString(node, "cwd", ""))).toBe(false);
    expect(asRec(withOptionalString(node, "cwd", "/x")).cwd).toBe("/x");
    expect("args" in asRec(withOptionalArray(node, "args", []))).toBe(false);
    expect(asRec(withOptionalArray(node, "args", ["a"])).args).toEqual(["a"]);
  });
});

describe("withConfig / nodeConfigOf / configString", () => {
  it("writes a config key", () => {
    const next = withConfig(binaryNode(), "model", "gpt");
    expect(nodeConfigOf(next)).toEqual({ model: "gpt" });
    expect(configString(next, "model")).toBe("gpt");
  });

  it("clearing the last config key drops the whole config object (no empty `config: {}` lands)", () => {
    const node = binaryNode({ config: { model: "gpt" } });
    const next = withConfig(node, "model", "");
    expect(nodeConfigOf(next)).toBeUndefined();
    expect("config" in asRec(next)).toBe(false);
  });

  it("clearing one of several config keys keeps the rest", () => {
    const node = binaryNode({ config: { model: "gpt", region: "eu" } });
    expect(nodeConfigOf(withConfig(node, "model", ""))).toEqual({ region: "eu" });
  });

  it("configString is empty for an absent or non-string key", () => {
    expect(configString(binaryNode(), "model")).toBe("");
    expect(configString(binaryNode({ config: { model: 7 } }), "model")).toBe("");
  });
});
