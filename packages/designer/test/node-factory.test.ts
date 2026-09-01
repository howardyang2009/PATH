import { describe, expect, it } from "vitest";
import { IdSchema, walkNodes, type WorkflowNode } from "@path/schema";
import { cloneWithFreshIdentity, createArm, createNode, usedNames } from "../src/node-factory.js";

/** Every id in a subtree, for uniqueness/format assertions. */
function ids(node: WorkflowNode): string[] {
  return [...walkNodes([node])].map((n) => n.id);
}

describe("node-factory — minting nodes with client identity (#368, ADR 0015)", () => {
  it("mints a fresh UUIDv4 id on every leaf kind", () => {
    for (const kind of ["prompt", "binary", "workflow", "api-call"]) {
      const node = createNode(kind, new Set());
      expect(IdSchema.safeParse(node.id).success).toBe(true);
      expect(node.type).toBe(kind);
    }
  });

  it("shapes each first-class leaf with its required field stubbed", () => {
    expect(createNode("prompt", new Set())).toMatchObject({ type: "prompt", prompt: "" });
    expect(createNode("binary", new Set())).toMatchObject({ type: "binary", command: "" });
    expect(createNode("workflow", new Set())).toMatchObject({ type: "workflow", ref: "" });
  });

  it("gives every minted name and id in a block subtree distinct, valid values", () => {
    const block = createNode("branch", new Set());
    const allIds = ids(block);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicate ids
    for (const id of allIds) expect(IdSchema.safeParse(id).success).toBe(true);
    const names = [...walkNodes([block])].map((n) => n.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names
  });

  it("pre-fills each block with its minimal legal occupants", () => {
    const seq = createNode("sequence", new Set());
    expect(seq.type === "sequence" && seq.body.length).toBe(1);
    const par = createNode("parallel", new Set());
    expect(par.type === "parallel" && par.branches.length).toBe(1);
    const br = createNode("branch", new Set());
    expect(br.type === "branch" && br.arms.length).toBe(1);
    const wh = createNode("while-do", new Set());
    expect(wh.type === "while-do" && Boolean(wh.node)).toBe(true);
  });

  it("derives a file-unique name against the used set", () => {
    const used = new Set(["prompt"]);
    expect(createNode("prompt", used).name).toBe("prompt-2");
    expect(createNode("prompt", used).name).toBe("prompt-3");
  });

  it("uses the given default leaf for a block's auto-filled occupants", () => {
    const wh = createNode("while-do", new Set(), "binary");
    expect(wh.type === "while-do" && wh.node.type).toBe("binary");
  });

  it("clones a subtree with fresh ids and names (a paste is a new node, not an alias)", () => {
    const original = createNode("parallel", new Set());
    const clone = cloneWithFreshIdentity(original, usedNames([original]));
    const origIds = new Set(ids(original));
    for (const id of ids(clone)) expect(origIds.has(id)).toBe(false); // every id is fresh
    expect(clone.name).not.toBe(original.name);
  });

  it("createArm mints a fresh occupant and a default when", () => {
    const arm = createArm(new Set());
    expect(IdSchema.safeParse(arm.node.id).success).toBe(true);
    expect(arm.when.type).toBe("exists");
  });
});
