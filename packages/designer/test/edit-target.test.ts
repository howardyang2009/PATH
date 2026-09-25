import { describe, expect, it } from "vitest";
import type { WorkflowFile, WorkflowNode } from "@path/schema";
import { replaceNode, withOptionalKey, withoutKey } from "../src/edit-target.js";

/**
 * The pane's one write door into the Buffer (#architecture-deepening): the node splice the field commits
 * and the ref-authoring flow share, and the "an empty field omits the key" policy the file regions, the
 * config helpers and the node helpers all read.
 */

const UUID = "aaaaaaaa-1111-4111-8111-111111111111";

function node(id: string, name: string): WorkflowNode {
  return { type: "binary", id, name, command: "echo" } as unknown as WorkflowNode;
}

const file: WorkflowFile = {
  format: "path/workflow@5",
  id: "workflow-id",
  name: "wf",
  body: [node(UUID, "first"), node("bbbbbbbb-2222-4222-8222-222222222222", "second")],
};

describe("withoutKey", () => {
  it("returns a copy without the key, leaving the original untouched", () => {
    const value = { keep: 1, drop: 2 };

    expect(withoutKey(value, "drop")).toEqual({ keep: 1 });
    expect(value).toEqual({ keep: 1, drop: 2 });
  });

  it("is a no-op for a key that is absent", () => {
    expect(withoutKey({ keep: 1 }, "drop")).toEqual({ keep: 1 });
  });
});

describe("withOptionalKey", () => {
  it("sets the key when a value is given", () => {
    expect(withOptionalKey({ keep: 1 }, "next", "v")).toEqual({ keep: 1, next: "v" });
  });

  it("omits the key entirely when the value is undefined, rather than writing an empty one", () => {
    expect(withOptionalKey({ keep: 1, next: "v" }, "next", undefined)).toEqual({ keep: 1 });
  });
});

describe("replaceNode", () => {
  it("splices the edited node in place in its body, by id", () => {
    const edited = replaceNode(file, { ...node(UUID, "renamed"), command: "printf" } as unknown as WorkflowNode);

    expect(edited.body.map((n) => (n as { command?: string }).command)).toEqual(["printf", "echo"]);
    expect(edited.body.map((n) => n.name)).toEqual(["renamed", "second"]);
    // A new file object, never a mutation of the one handed in.
    expect(file.body[0]!.name).toBe("first");
  });

  it("hands back the same file for an id the body does not hold — a stale commit is a no-op", () => {
    expect(replaceNode(file, node("cccccccc-3333-4333-8333-333333333333", "ghost"))).toBe(file);
  });
});
