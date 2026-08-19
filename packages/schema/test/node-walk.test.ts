import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "../src/node-type.js";
import { childBodies, walkNodes } from "../src/node-walk.js";
import { safeParseWorkflowFile } from "../src/workflow-file.js";

// Structural tests (childBodies/walkNodes) never pass through the schema, so the human id doubles as
// both `id` and `name` here — walkNodes maps `node.id` and childBodies exposes each slot's nodes.
const step = (id: string, publish?: Record<string, string>): WorkflowNode => ({
  type: "binary",
  id,
  name: id,
  command: "node",
  args: ["-e", ""],
  ...(publish ? { publish } : {}),
});

/**
 * A node buried under every block kind at once: parallel branch → branch arm → while-do. In `@2`
 * every container slot holds a single node, so the branches are nodes directly and the arm / loop
 * bodies are single nodes.
 */
function deeplyNested(inner: WorkflowNode): WorkflowNode {
  return {
    type: "parallel",
    id: "fan",
    name: "fan",
    join: "collect",
    branches: [
      {
        type: "branch",
        id: "route",
        name: "route",
        arms: [
          {
            when: { type: "exists", path: "context.x" },
            node: {
              type: "while-do",
              id: "spin",
              name: "spin",
              condition: { type: "exists", path: "context.x" },
              max_iterations: 2,
              node: inner,
            },
          },
        ],
        else: step("fallback"),
      },
      step("r"),
    ],
  };
}

describe("childBodies", () => {
  it("returns nothing for a leaf", () => {
    expect(childBodies(step("s"))).toEqual([]);
    expect(childBodies({ type: "checkpoint", id: "gate", name: "gate", condition: { type: "exists", path: "context.x" } })).toEqual(
      [],
    );
  });

  it("reports a parallel's branches as concurrent single nodes", () => {
    const bodies = childBodies(deeplyNested(step("inner")));
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.nodes[0]!.name)).toEqual(["route", "r"]);
    expect(bodies.every((b) => b.concurrent)).toBe(true);
    expect(bodies[0]!.path).toEqual(["branches", 0]);
  });

  it("reports branch arms and else as single-node alternatives, never concurrent", () => {
    const branch: WorkflowNode = {
      type: "branch",
      id: "route",
      name: "route",
      arms: [
        { when: { type: "exists", path: "context.a" }, node: step("a") },
        { when: { type: "exists", path: "context.b" }, node: step("b") },
      ],
      else: step("c"),
    };
    const bodies = childBodies(branch);
    expect(bodies.map((b) => b.path)).toEqual([["arms", 0, "node"], ["arms", 1, "node"], ["else"]]);
    expect(bodies.map((b) => b.nodes[0]!.name)).toEqual(["a", "b", "c"]);
    expect(bodies.some((b) => b.concurrent)).toBe(false);
  });

  it("reports no children for a node type it does not know", () => {
    // A hand-constructed file can reach a walk without passing the schema, and a caller sweeping one
    // (`collectRunConfigs` in @path/engine) must get a list rather than the node back. Rejecting the
    // unknown type is the executor's job; the walk only says where children are.
    const unknown = { type: "telepathy", id: "guess" } as unknown as WorkflowNode;
    expect(childBodies(unknown)).toEqual([]);
    expect([...walkNodes([unknown])].map((n) => n.id)).toEqual(["guess"]);
  });

  it("reports a while-do body as a sequential single node — iterations do not race", () => {
    const loop: WorkflowNode = {
      type: "while-do",
      id: "spin",
      name: "spin",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      node: step("inner"),
    };
    expect(childBodies(loop)).toEqual([{ nodes: [step("inner")], path: ["node"], concurrent: false }]);
  });

  it("reports a sequence's body as a sequential node array", () => {
    const seq: WorkflowNode = {
      type: "sequence",
      id: "steps",
      name: "steps",
      body: [step("a"), step("b")],
    };
    expect(childBodies(seq)).toEqual([{ nodes: [step("a"), step("b")], path: ["body"], concurrent: false }]);
  });
});

describe("walkNodes", () => {
  it("reaches a node buried under every block kind at once", () => {
    const ids = [...walkNodes([deeplyNested(step("buried"))])].map((n) => n.id);
    expect(ids).toContain("buried");
    expect(ids).toEqual(["fan", "route", "spin", "buried", "fallback", "r"]);
  });

  it("descends through a sequence", () => {
    const seq: WorkflowNode = { type: "sequence", id: "steps", name: "steps", body: [step("a"), step("b")] };
    expect([...walkNodes([seq])].map((n) => n.id)).toEqual(["steps", "a", "b"]);
  });

  it("does not descend into a workflow step's ref'd file", () => {
    const ids = [...walkNodes([{ type: "workflow", id: "call", name: "call", ref: "./child.workflow.json" }])].map((n) => n.id);
    expect(ids).toEqual(["call"]);
  });
});

/**
 * The property the four `default: break` recursions silently dropped (#70): every check that walks a
 * workflow body must reach a body nested inside *every* block kind. Before this, adding a block type
 * meant these checks quietly stopped covering it — validation passed and the workflow misbehaved.
 */
describe("validation reaches deeply nested bodies", () => {
  // These tests go through the real schema, so every node needs a UUID `id`; the human labels above
  // are kept as `name` (which is what the uniqueness rule is now checked against).
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}`;
  function guidify<T>(node: T): T {
    if (typeof node !== "object" || node === null) return node;
    const n = { ...(node as Record<string, unknown>) };
    if ("id" in n) {
      if (!("name" in n) && typeof n.id === "string") n.name = n.id; // keep the human label as `name`
      n.id = uuid();
    }
    // `body`/`branches` are node arrays; `node`/`else` are single nodes; `arms` carry a `node`.
    for (const key of ["branches", "body"]) {
      if (Array.isArray(n[key])) n[key] = (n[key] as unknown[]).map((c) => guidify(c));
    }
    for (const key of ["node", "else"]) {
      if (key in n) n[key] = guidify(n[key]);
    }
    if (Array.isArray(n.arms)) {
      n.arms = (n.arms as Record<string, unknown>[]).map((arm) => ({ ...arm, node: guidify(arm.node) }));
    }
    return n as T;
  }
  function file(body: WorkflowNode[]) {
    return { format: "path/workflow@2", id: uuid(), name: "deep", worker: { type: "engine" }, body: body.map(guidify) };
  }

  it("catches a duplicate id buried under every block kind", () => {
    const result = safeParseWorkflowFile(file([step("twice"), deeplyNested(step("twice"))]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/twice/);
  });

  it("catches a parallel branch node's name colliding with a deeply nested node's name", () => {
    const result = safeParseWorkflowFile(file([deeplyNested(step("route"))]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/route/);
  });

  it("catches two concurrent branches publishing the same key from nested bodies", () => {
    const racing: WorkflowNode = {
      type: "parallel",
      id: "fan",
      name: "fan",
      join: "collect",
      branches: [
        {
          type: "while-do",
          id: "spin",
          name: "spin",
          condition: { type: "exists", path: "context.x" },
          max_iterations: 2,
          node: step("l", { shared: "${output}" }),
        },
        {
          type: "branch",
          id: "route",
          name: "route",
          arms: [{ when: { type: "exists", path: "context.x" }, node: step("r", { shared: "${output}" }) }],
        },
      ],
    };
    const result = safeParseWorkflowFile(file([racing]));
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a failure");
    expect(result.errors.join("\n")).toMatch(/shared/);
  });

  it("does not call sequential republishing of one key inside a sequence a collision", () => {
    const sequential: WorkflowNode = {
      type: "while-do",
      id: "spin",
      name: "spin",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 2,
      node: {
        type: "sequence",
        id: "steps",
        name: "steps",
        body: [step("a", { same: "${output}" }), step("b", { same: "${output}" })],
      },
    };
    expect(safeParseWorkflowFile(file([sequential])).success).toBe(true);
  });
});
