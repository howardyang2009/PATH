import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import { childBodies, walkNodes } from "../src/node-walk.js";
import { safeParseWorkflowFile } from "../src/workflow-file.js";

const step = (id: string, publish?: Record<string, string>): WorkflowNode => ({
  type: "binary",
  id,
  command: "node",
  args: ["-e", ""],
  ...(publish ? { publish } : {}),
});

/** A body buried under every block kind at once: parallel → branch arm → while-do. */
function deeplyNested(inner: WorkflowNode[]): WorkflowNode {
  return {
    type: "parallel",
    id: "fan",
    join: "collect",
    branches: [
      {
        id: "left",
        body: [
          {
            type: "branch",
            id: "route",
            arms: [
              {
                when: { type: "exists", path: "context.x" },
                body: [
                  {
                    type: "while-do",
                    id: "spin",
                    condition: { type: "exists", path: "context.x" },
                    max_iterations: 2,
                    body: inner,
                  },
                ],
              },
            ],
            else: [step("fallback")],
          },
        ],
      },
      { id: "right", body: [step("r")] },
    ],
  };
}

describe("childBodies", () => {
  it("returns nothing for a leaf", () => {
    expect(childBodies(step("s"))).toEqual([]);
    expect(childBodies({ type: "checkpoint", id: "gate", condition: { type: "exists", path: "context.x" } })).toEqual(
      [],
    );
  });

  it("reports a parallel's branches as concurrent, carrying their own ids", () => {
    const bodies = childBodies(deeplyNested([step("inner")]));
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.branchId)).toEqual(["left", "right"]);
    expect(bodies.every((b) => b.concurrent)).toBe(true);
    expect(bodies[0]!.path).toEqual(["branches", 0, "body"]);
  });

  it("reports branch arms and else as alternatives, never concurrent", () => {
    const branch: WorkflowNode = {
      type: "branch",
      id: "route",
      arms: [
        { when: { type: "exists", path: "context.a" }, body: [step("a")] },
        { when: { type: "exists", path: "context.b" }, body: [step("b")] },
      ],
      else: [step("c")],
    };
    const bodies = childBodies(branch);
    expect(bodies.map((b) => b.path)).toEqual([["arms", 0, "body"], ["arms", 1, "body"], ["else"]]);
    expect(bodies.some((b) => b.concurrent)).toBe(false);
  });

  it("reports a while-do body as sequential — iterations do not race", () => {
    const loop: WorkflowNode = {
      type: "while-do",
      id: "spin",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      body: [step("inner")],
    };
    expect(childBodies(loop)).toEqual([{ nodes: [step("inner")], path: ["body"], concurrent: false }]);
  });
});

describe("walkNodes", () => {
  it("reaches a node buried under every block kind at once", () => {
    const ids = [...walkNodes([deeplyNested([step("buried")])])].map((n) => n.id);
    expect(ids).toContain("buried");
    expect(ids).toEqual(["fan", "route", "spin", "buried", "fallback", "r"]);
  });

  it("does not descend into a workflow step's ref'd file", () => {
    const ids = [...walkNodes([{ type: "workflow", id: "call", ref: "./child.workflow.json" }])].map((n) => n.id);
    expect(ids).toEqual(["call"]);
  });
});

/**
 * The property the four `default: break` recursions silently dropped (#70): every check that walks a
 * workflow body must reach a body nested inside *every* block kind. Before this, adding a block type
 * meant these checks quietly stopped covering it — validation passed and the workflow misbehaved.
 */
describe("validation reaches deeply nested bodies", () => {
  function file(body: WorkflowNode[]) {
    return { format: "path/workflow@0", name: "deep", worker: { type: "engine" }, body };
  }

  it("catches a duplicate id buried under every block kind", () => {
    const result = safeParseWorkflowFile(file([step("twice"), deeplyNested([step("twice")])]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/twice/);
  });

  it("catches a parallel branch id colliding with a deeply nested node id", () => {
    const result = safeParseWorkflowFile(file([deeplyNested([step("left")])]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/left/);
  });

  it("catches two concurrent branches publishing the same key from nested bodies", () => {
    const racing: WorkflowNode = {
      type: "parallel",
      id: "fan",
      join: "collect",
      branches: [
        {
          id: "left",
          body: [
            {
              type: "while-do",
              id: "spin",
              condition: { type: "exists", path: "context.x" },
              max_iterations: 2,
              body: [step("l", { shared: "${output}" })],
            },
          ],
        },
        {
          id: "right",
          body: [
            {
              type: "branch",
              id: "route",
              arms: [{ when: { type: "exists", path: "context.x" }, body: [step("r", { shared: "${output}" })] }],
            },
          ],
        },
      ],
    };
    const result = safeParseWorkflowFile(file([racing]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/shared/);
  });

  it("does not call sequential republishing of one key a collision", () => {
    const sequential: WorkflowNode = {
      type: "while-do",
      id: "spin",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      body: [step("a", { same: "${output}" }), step("b", { same: "${output}" })],
    };
    expect(safeParseWorkflowFile(file([sequential])).success).toBe(true);
  });
});
