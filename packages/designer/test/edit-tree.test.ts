import { describe, expect, it } from "vitest";
import { FORMAT_VERSION, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { editFile, findById, isDuplicable, locate, unwrapEdit, type EditOp, type EditResult } from "../src/edit-tree.js";
import { cloneWithFreshIdentity, createArm, createNode, usedNames } from "../src/node-factory.js";

/** Apply one op and unwrap it to the new file — for the total ops (every op but `delete`). */
function apply(file: WorkflowFile, op: EditOp): WorkflowFile {
  return unwrapEdit(editFile(file, op));
}
/** Apply a `delete` op, returning the raw result so a refusal can be asserted. */
function del(file: WorkflowFile, id: string): EditResult {
  return editFile(file, { kind: "delete", id });
}

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}
function leaf(id: number, name: string): WorkflowNode {
  return { type: "prompt", id: uuid(id), name, prompt: "" };
}

/** A file exercising every container: a top step, a sequence, a parallel, a branch (arm + else), a while-do. */
function fixture(): WorkflowFile {
  return {
    format: FORMAT_VERSION,
    id: uuid(1),
    name: "flow",
    body: [
      leaf(2, "top-a"),
      { type: "sequence", id: uuid(3), name: "seq", body: [leaf(4, "s1"), leaf(5, "s2")] },
      { type: "parallel", id: uuid(6), name: "par", join: "collect", branches: [leaf(7, "b1"), leaf(8, "b2")] },
      {
        type: "branch",
        id: uuid(9),
        name: "br",
        arms: [
          { when: { type: "exists", path: "context.x" }, node: leaf(10, "arm1") },
          { when: { type: "exists", path: "context.y" }, node: leaf(11, "arm2") },
        ],
        else: leaf(12, "els"),
      },
      { type: "while-do", id: uuid(13), name: "wh", condition: { type: "exists", path: "context.z" }, max_iterations: 3, node: leaf(14, "body") },
    ],
  };
}

function names(file: WorkflowFile): string[] {
  return [...walkNodes(file.body)].map((n) => n.name);
}
function ids(file: WorkflowFile): string[] {
  return [...walkNodes(file.body)].map((n) => n.id);
}

describe("edit-tree — locate (#368)", () => {
  it("locates a node in each container kind", () => {
    const f = fixture();
    expect(locate(f, uuid(2))).toEqual({ where: "file-body", index: 0 });
    expect(locate(f, uuid(5))).toMatchObject({ where: "list", listKind: "sequence-body", ownerId: uuid(3), index: 1 });
    expect(locate(f, uuid(8))).toMatchObject({ where: "list", listKind: "branches", ownerId: uuid(6), index: 1 });
    expect(locate(f, uuid(11))).toEqual({ where: "arm", ownerId: uuid(9), armIndex: 1 });
    expect(locate(f, uuid(12))).toEqual({ where: "else", ownerId: uuid(9) });
    expect(locate(f, uuid(14))).toEqual({ where: "while-body", ownerId: uuid(13) });
    expect(locate(f, "missing")).toBeNull();
  });
});

describe("edit-tree — add into a list socket (#368)", () => {
  it("appends to the file body, a sequence body, and a parallel branch list", () => {
    let f = fixture();
    f = apply(f, { kind: "add-to-list", ownerId: null, node: leaf(20, "new-top") });
    f = apply(f, { kind: "add-to-list", ownerId: uuid(3), node: leaf(21, "new-seq") });
    f = apply(f, { kind: "add-to-list", ownerId: uuid(6), node: leaf(22, "new-branch") });
    expect(f.body).toHaveLength(6);
    expect((f.body[1] as { body: WorkflowNode[] }).body).toHaveLength(3);
    expect((f.body[2] as { branches: WorkflowNode[] }).branches).toHaveLength(3);
  });
});

describe("edit-tree — reorder preserves every id (#368, ADR 0015)", () => {
  it("moves a top-level node down and keeps all ids", () => {
    const f = fixture();
    const before = ids(f).sort();
    const moved = apply(f, { kind: "move", id: uuid(2), delta: 1 });
    expect(moved.body[0]!.id).toBe(uuid(3)); // seq rose to the top
    expect(moved.body[1]!.id).toBe(uuid(2));
    expect(ids(moved).sort()).toEqual(before); // no id changed
  });

  it("reorders inside a sequence and inside branch arms", () => {
    let f = fixture();
    f = apply(f, { kind: "move", id: uuid(4), delta: 1 }); // s1 down within seq
    expect((f.body[1] as { body: WorkflowNode[] }).body.map((n) => n.id)).toEqual([uuid(5), uuid(4)]);
    f = apply(f, { kind: "move", id: uuid(11), delta: -1 }); // arm2 up
    expect((f.body[3] as { arms: { node: WorkflowNode }[] }).arms.map((a) => a.node.id)).toEqual([uuid(11), uuid(10)]);
  });

  it("is a no-op off either end and for a single-node slot, returning the same file (no spurious edit)", () => {
    const f = fixture();
    expect(apply(f, { kind: "move", id: uuid(2), delta: -1 })).toBe(f); // already first in the file body
    expect(apply(f, { kind: "move", id: uuid(14), delta: -1 })).toBe(f); // while body has no siblings
    expect(apply(f, { kind: "move", id: uuid(7), delta: -1 })).toBe(f); // first parallel branch, up
    expect(apply(f, { kind: "move", id: uuid(8), delta: 1 })).toBe(f); // last parallel branch, down
    expect(apply(f, { kind: "move", id: uuid(10), delta: -1 })).toBe(f); // first branch arm, up
    expect(apply(f, { kind: "move", id: uuid(11), delta: 1 })).toBe(f); // last branch arm, down
  });
});

describe("edit-tree — swap a single-node slot (#368)", () => {
  it("swaps a while-do body, a branch arm occupant, and an else, never emptying the slot", () => {
    let f = fixture();
    f = apply(f, { kind: "swap-single", target: { slot: "while-body", ownerId: uuid(13) }, node: leaf(30, "new-body") });
    expect((f.body[4] as { node: WorkflowNode }).node.id).toBe(uuid(30));
    f = apply(f, { kind: "swap-single", target: { slot: "arm", ownerId: uuid(9), armIndex: 0 }, node: leaf(31, "new-arm") });
    expect((f.body[3] as { arms: { node: WorkflowNode }[] }).arms[0]!.node.id).toBe(uuid(31));
    f = apply(f, { kind: "swap-single", target: { slot: "else", ownerId: uuid(9) }, node: leaf(32, "new-else") });
    expect((f.body[3] as { else: WorkflowNode }).else.id).toBe(uuid(32));
  });
});

describe("edit-tree — delete slot rules (#368)", () => {
  it("removes a plain file-body node, allowing the body to empty", () => {
    const f: WorkflowFile = { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [leaf(2, "only")] };
    const r = del(f, uuid(2));
    expect(r.ok && r.file.body).toEqual([]);
  });

  it("deleting a while-do body deletes the whole loop", () => {
    const r = del(fixture(), uuid(14));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.body.some((n) => n.id === uuid(13))).toBe(false);
  });

  it("refuses deleting the last parallel branch or the last branch arm", () => {
    const r1 = del(fixture(), uuid(7)); // one of two branches — allowed
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const last = del(r1.file, uuid(8)); // now the last branch
      expect(last.ok).toBe(false);
    }
    const g = del(fixture(), uuid(10)); // arm1 of two — allowed
    expect(g.ok).toBe(true);
    if (g.ok) {
      const lastArm = del(g.file, uuid(11));
      expect(lastArm.ok).toBe(false);
    }
  });

  it("emptying a sequence deletes the sequence node itself", () => {
    const r1 = del(fixture(), uuid(4));
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const r2 = del(r1.file, uuid(5)); // seq now empty → seq removed
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.file.body.some((n) => n.id === uuid(3))).toBe(false);
    }
  });

  it("deleting an else occupant removes the else, keeping the branch", () => {
    const r = del(fixture(), uuid(12));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const br = r.file.body.find((n) => n.id === uuid(9)) as { else?: WorkflowNode };
      expect(br.else).toBeUndefined();
    }
  });

  it("unwrapEdit throws on a refused delete rather than dropping it", () => {
    const oneBranch = unwrapEdit(del(fixture(), uuid(7))); // remove b1, leaving the parallel with only b2
    expect(() => unwrapEdit(del(oneBranch, uuid(8)))).toThrow(/edit refused/); // the last branch is refused
  });
});

describe("edit-tree — else management (#368: at most one else)", () => {
  it("adds an else only when there is none", () => {
    let f = apply(fixture(), { kind: "remove-else", branchId: uuid(9) });
    expect((f.body[3] as { else?: WorkflowNode }).else).toBeUndefined();
    f = apply(f, { kind: "add-else", branchId: uuid(9), node: leaf(40, "e") });
    expect((f.body[3] as { else?: WorkflowNode }).else!.id).toBe(uuid(40));
    // A second add is a no-op — at most one else.
    f = apply(f, { kind: "add-else", branchId: uuid(9), node: leaf(41, "e2") });
    expect((f.body[3] as { else?: WorkflowNode }).else!.id).toBe(uuid(40));
  });
});

describe("edit-tree — arm and duplicate (#368)", () => {
  it("adds an arm to a branch", () => {
    const f = apply(fixture(), { kind: "add-arm", branchId: uuid(9), arm: createArm(usedNames(fixture().body)) });
    expect((f.body[3] as { arms: unknown[] }).arms).toHaveLength(3);
  });

  it("duplicates a list node after itself with fresh identity", () => {
    const f = fixture();
    expect(isDuplicable(f, uuid(2))).toBe(true);
    expect(isDuplicable(f, uuid(14))).toBe(false); // a while-body occupant is not a list node
    const clone = cloneWithFreshIdentity(f.body[1]!, usedNames(f.body)); // clone the sequence
    const g = apply(f, { kind: "insert-after", id: uuid(3), clone });
    expect(g.body).toHaveLength(6);
    expect(g.body[2]!.id).toBe(clone.id);
    expect(new Set(ids(g)).size).toBe(ids(g).length); // all ids still distinct
    expect(new Set(names(g)).size).toBe(names(g).length); // all names still distinct
  });
});

describe("edit-tree — replace (#369: the pane's content commit)", () => {
  it("replaces a deep node's content, preserving its siblings and their ids", () => {
    const f = fixture();
    const armOccupant = leaf(50, "arm1-renamed");
    const g = apply(f, { kind: "replace", id: uuid(10), node: armOccupant });
    const branch = g.body[3] as { arms: { node: WorkflowNode }[] };
    expect(branch.arms[0]!.node.name).toBe("arm1-renamed");
    expect(branch.arms[1]!.node.id).toBe(uuid(11)); // sibling untouched
    expect(g.body[0]!.id).toBe(uuid(2)); // top-level sibling untouched
  });

  it("re-keys a node — the match is on the old id, the replacement carries the new one", () => {
    const f = fixture();
    const g = apply(f, { kind: "replace", id: uuid(2), node: { ...(f.body[0] as WorkflowNode), id: uuid(99) } });
    expect(g.body[0]!.id).toBe(uuid(99));
    expect(locate(g, uuid(2))).toBeNull();
  });

  it("is a no-op for an absent id (returns the same file reference)", () => {
    const f = fixture();
    expect(apply(f, { kind: "replace", id: uuid(999), node: leaf(60, "x") })).toBe(f);
  });
});

describe("edit-tree — set-arm-when (#370)", () => {
  it("sets a branch arm's condition, leaving its occupant untouched", () => {
    const f = fixture();
    const g = apply(f, { kind: "set-arm-when", branchId: uuid(9), armIndex: 0, when: { type: "exists", path: "context.new" } });
    const branch = g.body[3] as { arms: { when: { path?: string }; node: WorkflowNode }[] };
    expect(branch.arms[0]!.when).toEqual({ type: "exists", path: "context.new" });
    expect(branch.arms[0]!.node.id).toBe(uuid(10)); // occupant untouched
  });
});

describe("findById — the node-by-id lookup, sibling of locate", () => {
  it("finds a top-level node, a deeply nested one, and a branch arm occupant", () => {
    const f = fixture();
    expect(findById(f.body, uuid(2))?.name).toBe("top-a");
    expect(findById(f.body, uuid(5))?.name).toBe("s2"); // inside the sequence
    expect(findById(f.body, uuid(14))?.name).toBe("body"); // inside the while-do
    expect(findById(f.body, uuid(11))?.name).toBe("arm2"); // a branch arm occupant
  });

  it("returns null for an absent id", () => {
    expect(findById(fixture().body, uuid(999))).toBeNull();
  });
});
