import { describe, expect, it } from "vitest";
import { FORMAT_VERSION, walkNodes, type WorkflowFile, type WorkflowNode } from "@path/schema";
import {
  addArm,
  addElse,
  addToList,
  deleteNode,
  insertAfter,
  isDuplicable,
  locate,
  moveNode,
  removeElse,
  swapSingleSlot,
} from "../src/edit-tree.js";
import { cloneWithFreshIdentity, createArm, createNode, usedNames } from "../src/node-factory.js";

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
    f = addToList(f, null, leaf(20, "new-top"));
    f = addToList(f, uuid(3), leaf(21, "new-seq"));
    f = addToList(f, uuid(6), leaf(22, "new-branch"));
    expect(f.body).toHaveLength(6);
    expect((f.body[1] as { body: WorkflowNode[] }).body).toHaveLength(3);
    expect((f.body[2] as { branches: WorkflowNode[] }).branches).toHaveLength(3);
  });
});

describe("edit-tree — reorder preserves every id (#368, ADR 0015)", () => {
  it("moves a top-level node down and keeps all ids", () => {
    const f = fixture();
    const before = ids(f).sort();
    const moved = moveNode(f, uuid(2), 1);
    expect(moved.body[0]!.id).toBe(uuid(3)); // seq rose to the top
    expect(moved.body[1]!.id).toBe(uuid(2));
    expect(ids(moved).sort()).toEqual(before); // no id changed
  });

  it("reorders inside a sequence and inside branch arms", () => {
    let f = fixture();
    f = moveNode(f, uuid(4), 1); // s1 down within seq
    expect((f.body[1] as { body: WorkflowNode[] }).body.map((n) => n.id)).toEqual([uuid(5), uuid(4)]);
    f = moveNode(f, uuid(11), -1); // arm2 up
    expect((f.body[3] as { arms: { node: WorkflowNode }[] }).arms.map((a) => a.node.id)).toEqual([uuid(11), uuid(10)]);
  });

  it("is a no-op off either end and for a single-node slot", () => {
    const f = fixture();
    expect(moveNode(f, uuid(2), -1)).toBe(f); // already first
    expect(moveNode(f, uuid(14), -1)).toBe(f); // while body has no siblings
  });
});

describe("edit-tree — swap a single-node slot (#368)", () => {
  it("swaps a while-do body, a branch arm occupant, and an else, never emptying the slot", () => {
    let f = fixture();
    f = swapSingleSlot(f, { slot: "while-body", ownerId: uuid(13) }, leaf(30, "new-body"));
    expect((f.body[4] as { node: WorkflowNode }).node.id).toBe(uuid(30));
    f = swapSingleSlot(f, { slot: "arm", ownerId: uuid(9), armIndex: 0 }, leaf(31, "new-arm"));
    expect((f.body[3] as { arms: { node: WorkflowNode }[] }).arms[0]!.node.id).toBe(uuid(31));
    f = swapSingleSlot(f, { slot: "else", ownerId: uuid(9) }, leaf(32, "new-else"));
    expect((f.body[3] as { else: WorkflowNode }).else.id).toBe(uuid(32));
  });
});

describe("edit-tree — delete slot rules (#368)", () => {
  it("removes a plain file-body node, allowing the body to empty", () => {
    let f: WorkflowFile = { format: FORMAT_VERSION, id: uuid(1), name: "flow", body: [leaf(2, "only")] };
    const r = deleteNode(f, uuid(2));
    expect(r.ok && r.file.body).toEqual([]);
  });

  it("deleting a while-do body deletes the whole loop", () => {
    const r = deleteNode(fixture(), uuid(14));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.body.some((n) => n.id === uuid(13))).toBe(false);
  });

  it("refuses deleting the last parallel branch or the last branch arm", () => {
    let f = fixture();
    const r1 = deleteNode(f, uuid(7)); // one of two branches — allowed
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const last = deleteNode(r1.file, uuid(8)); // now the last branch
      expect(last.ok).toBe(false);
    }
    let g = deleteNode(fixture(), uuid(10)); // arm1 of two — allowed
    expect(g.ok).toBe(true);
    if (g.ok) {
      const lastArm = deleteNode(g.file, uuid(11));
      expect(lastArm.ok).toBe(false);
    }
  });

  it("emptying a sequence deletes the sequence node itself", () => {
    let f = fixture();
    const r1 = deleteNode(f, uuid(4));
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      const r2 = deleteNode(r1.file, uuid(5)); // seq now empty → seq removed
      expect(r2.ok).toBe(true);
      if (r2.ok) expect(r2.file.body.some((n) => n.id === uuid(3))).toBe(false);
    }
  });

  it("deleting an else occupant removes the else, keeping the branch", () => {
    const r = deleteNode(fixture(), uuid(12));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const br = r.file.body.find((n) => n.id === uuid(9)) as { else?: WorkflowNode };
      expect(br.else).toBeUndefined();
    }
  });
});

describe("edit-tree — else management (#368: at most one else)", () => {
  it("adds an else only when there is none", () => {
    let f = removeElse(fixture(), uuid(9));
    expect((f.body[3] as { else?: WorkflowNode }).else).toBeUndefined();
    f = addElse(f, uuid(9), leaf(40, "e"));
    expect((f.body[3] as { else?: WorkflowNode }).else!.id).toBe(uuid(40));
    // A second add is a no-op — at most one else.
    f = addElse(f, uuid(9), leaf(41, "e2"));
    expect((f.body[3] as { else?: WorkflowNode }).else!.id).toBe(uuid(40));
  });
});

describe("edit-tree — arm and duplicate (#368)", () => {
  it("adds an arm to a branch", () => {
    const f = addArm(fixture(), uuid(9), createArm(usedNames(fixture().body)));
    expect((f.body[3] as { arms: unknown[] }).arms).toHaveLength(3);
  });

  it("duplicates a list node after itself with fresh identity", () => {
    const f = fixture();
    expect(isDuplicable(f, uuid(2))).toBe(true);
    expect(isDuplicable(f, uuid(14))).toBe(false); // a while-body occupant is not a list node
    const clone = cloneWithFreshIdentity(f.body[1]!, usedNames(f.body)); // clone the sequence
    const g = insertAfter(f, uuid(3), clone);
    expect(g.body).toHaveLength(6);
    expect(g.body[2]!.id).toBe(clone.id);
    expect(new Set(ids(g)).size).toBe(ids(g).length); // all ids still distinct
    expect(new Set(names(g)).size).toBe(names(g).length); // all names still distinct
  });
});
