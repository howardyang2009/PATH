import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import { publishKeysOf, publishSetIssues } from "../src/publish-set.js";
import { FORMAT_VERSION, type WorkflowFile } from "../src/workflow-file-type.js";

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function pub(id: number, name: string, publish: Record<string, string>): WorkflowNode {
  return { type: "prompt", id: uuid(id), name, prompt: "x", publish } as never;
}

function wrap(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: uuid(1), name: "flow", body };
}

describe("publishSetIssues — the one publish-set rule, as data", () => {
  it("names the later branch of a collect same-key race, at that branch's path", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "fan",
        join: "collect",
        branches: [pub(2, "b1", { k: "${output.a}" }), pub(3, "b2", { k: "${output.a}" })],
      } as never,
    ]);
    const issues = publishSetIssues(file);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule: "sibling-race",
      nodeId: uuid(3),
      path: ["body", 0, "branches", 1],
    });
    expect(issues[0]!.message).toContain('duplicate publish key "k"');
  });

  it("says nothing about a wait-one race — only the winner lands", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "fan",
        join: "wait-one",
        branches: [pub(2, "b1", { k: "${output.a}" }), pub(3, "b2", { k: "${output.a}" })],
      } as never,
    ]);
    expect(publishSetIssues(file)).toEqual([]);
  });

  it("names each publishing node under a do-not-wait branch, even nested", () => {
    const file = wrap([
      {
        type: "parallel",
        id: uuid(10),
        name: "detach",
        join: "do-not-wait",
        branches: [
          {
            type: "sequence",
            id: uuid(11),
            name: "seq",
            body: [pub(2, "b1", { k: "${output.a}" })],
          } as never,
        ],
      } as never,
    ]);
    const issues = publishSetIssues(file);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      rule: "detached-publish",
      nodeId: uuid(2),
      // The path lands on the key, not the node — the loader points at the offending `publish` field,
      // through the branch slot, the sequence node, and the sequence's own `body` index.
      path: ["body", 0, "branches", 0, 0, "body", 0, "publish", "k"],
    });
    expect(issues[0]!.message).toContain("inside a do-not-wait branch");
  });

  it("reports nothing for a clean file", () => {
    const file = wrap([pub(2, "a", { k1: "${output.a}" }), pub(3, "b", { k2: "${output.b}" })]);
    expect(publishSetIssues(file)).toEqual([]);
  });
});

describe("publishKeysOf", () => {
  it("reads a node's publish keys by presence, so a plugin leaf's count too", () => {
    expect(publishKeysOf(pub(2, "a", { k1: "${output.a}", k2: "${output.b}" }))).toEqual(["k1", "k2"]);
    expect(publishKeysOf({ type: "prompt", id: uuid(3), name: "b", prompt: "x" } as never)).toEqual([]);
  });
});
