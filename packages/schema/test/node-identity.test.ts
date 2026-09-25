import { describe, expect, it } from "vitest";
import {
  identityIssues,
  nodeIdentityIssues,
  nodeIdentityOccurrences,
  workflowIdentityOccurrence,
  type IdentityOccurrence,
} from "../src/node-identity.js";
import { safeParseWorkflowFile } from "../src/workflow-file.js";
import { builtinRegistry } from "./builtin-registry.js";
import type { WorkflowFile } from "../src/workflow-file-type.js";

/**
 * Node identity's one rule (#architecture-deepening): `identityIssues` is what the load refinement's
 * name check, the write route's duplicate-`id` check and the Designer's pre-parse open gate now share.
 * These tests pin the rule itself, the walk's paths, and the door split ADR 0015 draws — the load
 * checks `name`s, the write door and the Designer check `id`s.
 */

const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

/** A body exercising every nesting shape: a step, a branch with an arm and an `else`, and a loop body. */
const nested: WorkflowFile = {
  format: "path/workflow@5",
  id: WORKFLOW_ID,
  name: "nested",
  body: [
    { type: "binary", id: NODE_ID, name: "first", command: "echo" },
    {
      type: "branch",
      id: OTHER_ID,
      name: "route",
      arms: [{ when: { type: "exists", path: "context.x" }, node: { type: "binary", id: OTHER_ID, name: "arm", command: "echo" } }],
      else: { type: "binary", id: OTHER_ID, name: "fallback", command: "echo" },
    },
    {
      type: "while-do",
      id: OTHER_ID,
      name: "loop",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      node: { type: "binary", id: OTHER_ID, name: "body", command: "echo" },
    },
  ],
};

describe("nodeIdentityOccurrences", () => {
  it("walks the block grammar depth-first, with the JSON paths the load refinement reports against", () => {
    // A child body's nodes are indexed inside their slot (`childBodies`' path plus the position in it),
    // so an arm occupant is `body.1.arms.0.node.0` — the shape the load refinement already reported, kept
    // here so a shared walk cannot quietly move an existing error path.
    expect(nodeIdentityOccurrences(nested).map((occurrence) => occurrence.path)).toEqual([
      ["body", 0],
      ["body", 1],
      ["body", 1, "arms", 0, "node", 0],
      ["body", 1, "else", 0],
      ["body", 2],
      ["body", 2, "node", 0],
    ]);
  });

  it("does not include the workflow's own row — a door that wants it says so", () => {
    expect(workflowIdentityOccurrence(nested)).toEqual({ id: WORKFLOW_ID, name: "nested", path: [] });
  });
});

describe("identityIssues", () => {
  const occurrence = (id: unknown, name: unknown, path: (string | number)[]): IdentityOccurrence => ({ id, name, path });

  it("reports each duplicate after the first, naming the holder as firstPath", () => {
    const issues = identityIssues(
      [occurrence(NODE_ID, "dup", ["body", 0]), occurrence(NODE_ID, "dup", ["body", 1]), occurrence(NODE_ID, "dup", ["body", 2])],
      ["duplicate-name"],
    );

    expect(issues).toEqual([
      { rule: "duplicate-name", value: "dup", path: ["body", 1], firstPath: ["body", 0] },
      { rule: "duplicate-name", value: "dup", path: ["body", 2], firstPath: ["body", 0] },
    ]);
  });

  it("groups one id shared by the workflow row and a node, so a door can render either shape", () => {
    const file: WorkflowFile = { ...nested, body: [{ type: "binary", id: WORKFLOW_ID, name: "same", command: "echo" }] };
    const issues = identityIssues([workflowIdentityOccurrence(file), ...nodeIdentityOccurrences(file)], ["duplicate-id"]);

    expect(issues).toEqual([{ rule: "duplicate-id", value: WORKFLOW_ID, path: ["body", 0], firstPath: [] }]);
  });

  it("flags a present-but-invalid id and ignores an absent one, which is repaired rather than refused", () => {
    const issues = identityIssues(
      [occurrence(undefined, "a", ["body", 0]), occurrence("not-a-uuid", "b", ["body", 1]), occurrence(42, "c", ["body", 2])],
      ["invalid-id"],
    );

    expect(issues.map((issue) => issue.path)).toEqual([["body", 1], ["body", 2]]);
    expect(issues.map((issue) => issue.value)).toEqual(["not-a-uuid", 42]);
  });

  it("returns the rules in the order asked for, so a door can check one taxonomy before another", () => {
    const issues = identityIssues(
      [occurrence("not-a-uuid", "a", ["body", 0]), occurrence("not-a-uuid", "b", ["body", 1])],
      ["duplicate-id", "invalid-id"],
    );

    expect(issues.map((issue) => issue.rule)).toEqual(["duplicate-id", "invalid-id", "invalid-id"]);
  });
});

describe("the identity rules each door enforces (ADR 0015)", () => {
  it("the load refinement refuses a duplicate name at the offending name field", () => {
    const result = safeParseWorkflowFile(
      { ...nested, body: [nested.body[0], { type: "binary", id: OTHER_ID, name: "first", command: "echo" }] },
      builtinRegistry,
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errors.join("\n")).toContain('body.1.name: duplicate name "first": names must be unique across the whole file');
  });

  it("the load refinement accepts a duplicate id — that refusal belongs to the write door and the Designer", () => {
    const shared: WorkflowFile = {
      ...nested,
      body: [
        { type: "binary", id: NODE_ID, name: "one", command: "echo" },
        { type: "binary", id: NODE_ID, name: "two", command: "echo" },
      ],
    };

    expect(safeParseWorkflowFile(shared, builtinRegistry).success).toBe(true);
    expect(nodeIdentityIssues(shared, ["duplicate-id"]).map((issue) => issue.path)).toEqual([["body", 1]]);
  });
});
