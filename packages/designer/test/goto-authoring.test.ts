import { FORMAT_VERSION, type WorkflowFile, type WorkflowNode } from "@path/schema";
import { describe, expect, it } from "vitest";
import { editFile, unwrapEdit } from "../src/edit-tree.js";
import { createEditor } from "../src/editor-api.js";
import { gotoDirection, gotoTargetOptions, incomingGotos } from "../src/goto-view.js";
import {
  carriesEnvelope,
  socketAcceptsBody,
  socketAcceptsKind,
  socketBarred,
} from "../src/grammar.js";
import { createNode } from "../src/node-factory.js";
import { openWorkflowFile } from "../src/open-workflow.js";
import { paletteGroups } from "../src/palette-data.js";
import { fileProblems } from "../src/problems.js";
import { canonicalSerialize } from "../src/serialize.js";
import { DEFAULT_PLUGINS } from "./stub-server.js";

/**
 * #619 — goto authoring in the Designer (docs/spec/goto.md §9, designer-spec § goto): the pure seams —
 * the ancestor-aware grammar, the mint, the edit door's placement refusal and rename rewrite, the goto
 * markers, and the chip / picker / badge derivations the canvas and pane read.
 */

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}
function leaf(id: number, name: string): WorkflowNode {
  return { type: "prompt", id: uuid(id), name, prompt: "x" };
}
function goto(id: number, name: string, target: string): WorkflowNode {
  return { type: "goto", id: uuid(id), name, target, max_jumps: 3 };
}
function wrap(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body };
}

/** start · loop (while-do over a sequence) · fan (parallel) · gate (branch holding a goto) · done. */
function fixture(): WorkflowFile {
  return wrap([
    leaf(2, "start"),
    {
      type: "while-do",
      id: uuid(3),
      name: "loop",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      node: { type: "sequence", id: uuid(4), name: "loop-body", body: [leaf(5, "inner")] },
    },
    { type: "parallel", id: uuid(6), name: "fan", join: "collect", branches: [leaf(7, "b1")] },
    {
      type: "branch",
      id: uuid(8),
      name: "gate",
      arms: [{ when: { type: "exists", path: "context.y" }, node: goto(9, "retry", "start") }],
    },
    leaf(10, "done"),
  ]);
}

const noop = (): void => {};

describe("grammar — goto placement reads the socket's ancestor chain", () => {
  it("goto is a controller without a step envelope", () => {
    expect(carriesEnvelope("goto")).toBe(false);
  });

  it("bars a socket owned by, or nested under, a while-do or a parallel", () => {
    const file = fixture();
    expect(socketBarred(file.body, null)).toBe(false); // the file body
    expect(socketBarred(file.body, uuid(3))).toBe(true); // the while-do's own body slot
    expect(socketBarred(file.body, uuid(4))).toBe(true); // a sequence inside the while-do
    expect(socketBarred(file.body, uuid(6))).toBe(true); // a parallel's branch list
    expect(socketBarred(file.body, uuid(8))).toBe(false); // a branch arm at first level
  });

  it("refuses goto only at a barred socket, and admits every other kind there", () => {
    for (const flavor of ["sequence", "single", "branches"] as const) {
      expect(socketAcceptsKind(flavor, "goto", true)).toBe(false);
      expect(socketAcceptsKind(flavor, "prompt", true)).toBe(true);
    }
    expect(socketAcceptsKind("sequence", "goto", false)).toBe(true);
    expect(socketAcceptsKind("single", "goto", false)).toBe(true);
  });

  it("refuses a template body holding a goto at any depth in a barred socket", () => {
    const body = [
      { type: "sequence", id: uuid(20), name: "s", body: [goto(21, "g", "x")] } as WorkflowNode,
    ];
    expect(socketAcceptsBody("branches", body, true)).toBe(false);
    expect(socketAcceptsBody("single", body, true)).toBe(false);
    expect(socketAcceptsBody("sequence", body, false)).toBe(true);
  });
});

describe("palette and mint", () => {
  it("offers goto in the Controller group", () => {
    const controllers = paletteGroups([]).find((group) => group.title === "Controller")!;
    expect(controllers.entries.map((entry) => entry.kind)).toContain("goto");
    const tabs = controllers.tabs!.map((tab) => [
      tab.label,
      tab.entries.map((entry) => entry.kind),
    ]);
    expect(tabs).toEqual([
      ["Structure", ["parallel", "branch", "while-do", "sequence", "checkpoint"]],
      ["Graph", ["goto"]],
    ]);
  });

  it("mints a goto with an empty target and max_jumps 3", () => {
    const node = createNode("goto", new Set(["goto"]));
    expect(node).toMatchObject({ type: "goto", name: "goto-2", target: "", max_jumps: 3 });
  });
});

describe("editor sockets (G-D-01, G-D-03)", () => {
  it("G-D-01: an armed goto opens no socket under a while-do or parallel, at any depth", () => {
    const editor = createEditor(fixture(), noop, { kind: "node", type: "goto" }, noop, "prompt");
    expect(editor.socketOpen("sequence", null)).toBe(true);
    expect(editor.socketOpen("single", uuid(8))).toBe(true);
    expect(editor.socketOpen("single", uuid(3))).toBe(false);
    expect(editor.socketOpen("sequence", uuid(4))).toBe(false);
    expect(editor.socketOpen("branches", uuid(6))).toBe(false);
  });

  it("G-D-03: a Template holding a goto opens no parallel branch socket", () => {
    const body = [leaf(30, "a"), goto(31, "g", "start")];
    const editor = createEditor(
      fixture(),
      noop,
      { kind: "step-template", id: "t", name: "t", body },
      noop,
      "prompt",
    );
    expect(editor.socketOpen("branches", uuid(6))).toBe(false);
    expect(editor.socketOpen("sequence", null)).toBe(true);
  });
});

describe("edit door (G-D-02, G-D-04, G-D-05)", () => {
  it("G-D-02: an edit that puts a sequence holding a goto into a while-do is refused", () => {
    const moved = {
      type: "sequence",
      id: uuid(40),
      name: "carrier",
      body: [goto(41, "hop", "start")],
    } as WorkflowNode;
    const result = editFile(fixture(), {
      kind: "swap-single",
      target: { slot: "while-body", ownerId: uuid(3) },
      node: moved,
    });
    expect(result.ok).toBe(false);
    const intoParallel = editFile(fixture(), {
      kind: "add-to-list",
      ownerId: uuid(6),
      node: moved,
    });
    expect(intoParallel.ok).toBe(false);
  });

  it("G-D-04: renaming a target rewrites every goto naming it in the same edit", () => {
    const file = wrap([
      leaf(2, "start"),
      goto(3, "g1", "start"),
      { type: "sequence", id: uuid(4), name: "s", body: [goto(5, "g2", "start")] },
    ]);
    const next = unwrapEdit(
      editFile(file, { kind: "replace", id: uuid(2), node: { ...leaf(2, "begin") } }),
    );
    const targets = [
      next.body[1],
      (next.body[2] as Extract<WorkflowNode, { type: "sequence" }>).body[0],
    ].map((node) => (node as Extract<WorkflowNode, { type: "goto" }>).target);
    expect(targets).toEqual(["begin", "begin"]);
  });

  it("a rename through an empty name rewrites nothing, so a fresh goto's empty target is never captured", () => {
    const file = wrap([leaf(2, "start"), goto(3, "g1", "")]);
    const cleared = unwrapEdit(editFile(file, { kind: "replace", id: uuid(2), node: leaf(2, "") }));
    const renamed = unwrapEdit(
      editFile(cleared, { kind: "replace", id: uuid(2), node: leaf(2, "b") }),
    );
    expect((renamed.body[1] as Extract<WorkflowNode, { type: "goto" }>).target).toBe("");
  });

  it("a rename through a name another node holds rewrites nothing, so no goto is repointed at that node", () => {
    const file = wrap([leaf(2, "a"), leaf(3, "ab"), goto(4, "to-a", "a"), goto(5, "to-ab", "ab")]);
    // Typing "ab" toward "ac" passes through "a", which node 2 already holds.
    const through = unwrapEdit(
      editFile(file, { kind: "replace", id: uuid(3), node: leaf(3, "a") }),
    );
    const done = unwrapEdit(
      editFile(through, { kind: "replace", id: uuid(3), node: leaf(3, "ac") }),
    );
    const targets = done.body
      .slice(2)
      .map((node) => (node as Extract<WorkflowNode, { type: "goto" }>).target);
    expect(targets).toEqual(["a", "ab"]); // to-a still names the real "a"; to-ab is left dangling, and marked
  });

  it("renaming a nested node rewrites nothing: only a first-level node is a target", () => {
    const file = wrap([
      { type: "sequence", id: uuid(2), name: "s", body: [leaf(3, "inner")] },
      goto(4, "g", "inner"),
    ]);
    const next = unwrapEdit(
      editFile(file, { kind: "replace", id: uuid(3), node: leaf(3, "deep") }),
    );
    expect((next.body[1] as Extract<WorkflowNode, { type: "goto" }>).target).toBe("inner");
  });

  it("G-D-05: deleting the target or moving it into a sequence is allowed and marks the goto", () => {
    const file = wrap([
      leaf(2, "start"),
      goto(3, "hop", "start"),
      { type: "sequence", id: uuid(4), name: "s", body: [leaf(5, "x")] },
    ]);
    const deleted = editFile(file, { kind: "delete", id: uuid(2) });
    expect(deleted.ok).toBe(true);
    expect(fileProblems(deleted.ok ? deleted.file : file)).toContainEqual(
      expect.objectContaining({ nodeId: uuid(3), kind: "target-absent" }),
    );

    const removed = unwrapEdit(editFile(file, { kind: "delete", id: uuid(2) }));
    const moved = editFile(removed, {
      kind: "add-to-list",
      ownerId: uuid(4),
      node: leaf(2, "start"),
    });
    expect(moved.ok).toBe(true);
    expect(fileProblems(moved.ok ? moved.file : file)).toContainEqual(
      expect.objectContaining({ nodeId: uuid(3), kind: "target-inner" }),
    );
  });
});

describe("chip, picker and badge derivations (G-D-06, G-D-07)", () => {
  it("lists every first-level node in file order, the goto's own node excluded, with a direction", () => {
    const file = wrap([leaf(2, "a"), goto(3, "g", "a"), leaf(4, "b")]);
    expect(gotoTargetOptions(file, uuid(3))).toEqual([
      { name: "a", direction: "backward" },
      { name: "b", direction: "forward" },
    ]);
  });

  it("keeps the first-level branch holding the goto eligible, as a backward jump", () => {
    const options = gotoTargetOptions(fixture(), uuid(9));
    expect(options.map((option) => option.name)).toEqual(["start", "loop", "fan", "gate", "done"]);
    expect(options.find((option) => option.name === "gate")!.direction).toBe("backward");
    expect(options.find((option) => option.name === "done")!.direction).toBe("forward");
  });

  it("reads a goto's direction, or null when its target is no first-level node", () => {
    const file = wrap([leaf(2, "a"), goto(3, "g", "a"), goto(4, "h", "gone")]);
    expect(gotoDirection(file, uuid(3))).toBe("backward");
    expect(gotoDirection(file, uuid(4))).toBeNull();
  });

  it("counts the incoming gotos of each first-level target", () => {
    const file = wrap([leaf(2, "a"), goto(3, "g1", "a"), goto(4, "g2", "a"), goto(5, "g3", "g1")]);
    const incoming = incomingGotos(file);
    expect(incoming.get("a")).toEqual(["g1", "g2"]);
    expect(incoming.get("g1")).toEqual(["g3"]);
  });
});

describe("round-trip", () => {
  it("a draft authored through the edit door saves as a valid @5 file", () => {
    let file = wrap([leaf(2, "start")]);
    const node = createNode("goto", new Set(["start"]));
    file = unwrapEdit(editFile(file, { kind: "add-to-list", ownerId: null, node }));
    file = unwrapEdit(
      editFile(file, {
        kind: "replace",
        id: node.id,
        node: { ...node, target: "start" } as WorkflowNode,
      }),
    );
    expect(file.format).toBe("path/workflow@5");
    const reopened = openWorkflowFile(canonicalSerialize(file), DEFAULT_PLUGINS);
    expect(reopened.status).toBe("opened");
    expect(reopened.status === "opened" && reopened.file).toEqual(file);
  });
});
