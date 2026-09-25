import { describe, expect, it } from "vitest";
import { instantiate, instantiateWorkflow } from "../src/instantiate.js";
import { FORMAT_VERSION, type WorkflowFile } from "../src/workflow-file-type.js";
import { walkNodes } from "../src/node-walk.js";
import type { WorkflowNode } from "../src/node-type.js";

// A UUIDv4 the fixtures reuse for every authored id — inner ids are authoring ids, and instantiation
// re-mints every one, so the source value never survives into the output.
const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The ADR 0049 acceptance fixture: a `person-activity`-shaped leaf followed by a `branch` controller
// whose arm reads the leaf's output by *value* (a name-level reference, untouched by instantiation).
function acceptanceBody(): WorkflowNode[] {
  return [
    { type: "prompt", id: UUID, name: "activity", prompt: "Do the thing" } as WorkflowNode,
    {
      type: "branch",
      id: UUID,
      name: "check",
      arms: [
        {
          when: { type: "equals", path: "context.activity.status", value: "ok" },
          node: { type: "prompt", id: UUID, name: "approve", prompt: "Approve" } as WorkflowNode,
        },
      ],
      else: { type: "prompt", id: UUID, name: "reject", prompt: "Reject" } as WorkflowNode,
    } as WorkflowNode,
  ];
}

function allIds(nodes: WorkflowNode[]): string[] {
  return [...walkNodes(nodes)].map((n) => (n as { id: string }).id);
}

function allNames(nodes: WorkflowNode[]): string[] {
  return [...walkNodes(nodes)].map((n) => (n as { name: string }).name);
}

describe("instantiate — detached copy", () => {
  it("returns a fresh array of the same length for a list socket", () => {
    const body = acceptanceBody();
    const out = instantiate(body);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(body);
  });

  it("re-mints every id at every depth, and never copies a source id", () => {
    const out = instantiate(acceptanceBody());
    const ids = allIds(out);
    // Two top-level nodes, one arm node, one else node = four ids.
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4);
      expect(id).not.toBe(UUID);
    }
    expect(new Set(ids).size).toBe(4);
  });

  it("two instantiations of one body yield disjoint id-sets (the golden test)", () => {
    const body = acceptanceBody();
    const a = new Set(allIds(instantiate(body)));
    const b = new Set(allIds(instantiate(body)));
    for (const id of a) expect(b.has(id)).toBe(false);
  });

  it("copies every other datum verbatim — a re-stamp of ids only leaves the rest byte-equal", () => {
    const out = instantiate(acceptanceBody());
    const prompt = out[0] as Extract<WorkflowNode, { type: "prompt" }>;
    expect(prompt.prompt).toBe("Do the thing");
    const branch = out[1] as Extract<WorkflowNode, { type: "branch" }>;
    expect(branch.arms[0]!.when).toEqual({ type: "equals", path: "context.activity.status", value: "ok" });
    // The arm's condition still names `activity` by value — instantiation never rewires.
    expect((branch.arms[0]!.when as { path: string }).path).toBe("context.activity.status");
  });

  it("keeps a `workflow` ref string verbatim while re-minting its node id", () => {
    const body: WorkflowNode[] = [{ type: "workflow", id: UUID, name: "sub", ref: "../other.workflow.json" } as WorkflowNode];
    const out = instantiate(body);
    const node = out[0] as Extract<WorkflowNode, { type: "workflow" }>;
    expect(node.ref).toBe("../other.workflow.json");
    expect(node.id).not.toBe(UUID);
  });

  it("deep-copies nested objects — mutating an output node leaves the source untouched", () => {
    const body: WorkflowNode[] = [
      { type: "prompt", id: UUID, name: "step", prompt: "x", publish: { out: { nested: 1 } } } as WorkflowNode,
    ];
    const out = instantiate(body);
    const outPublish = (out[0] as unknown as { publish: { out: { nested: number } } }).publish;
    outPublish.out.nested = 999;
    const srcPublish = (body[0] as unknown as { publish: { out: { nested: number } } }).publish;
    expect(srcPublish.out.nested).toBe(1);
  });

  it("does not mutate the source body", () => {
    const body = acceptanceBody();
    const before = JSON.stringify(body);
    instantiate(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("instantiate — names", () => {
  it("keeps names verbatim when nothing in the target collides", () => {
    const out = instantiate(acceptanceBody());
    expect(allNames(out)).toEqual(["activity", "check", "approve", "reject"]);
  });

  it("uniquifies a colliding name against the target's used names, others verbatim", () => {
    const out = instantiate(acceptanceBody(), { usedNames: ["check"] });
    expect(allNames(out)).toEqual(["activity", "check-2", "approve", "reject"]);
  });

  it("uniquifies against names assigned earlier in the same insert", () => {
    const body: WorkflowNode[] = [
      { type: "prompt", id: UUID, name: "step", prompt: "a" } as WorkflowNode,
      { type: "prompt", id: UUID, name: "step", prompt: "b" } as WorkflowNode,
    ];
    const out = instantiate(body, { usedNames: ["step"] });
    expect(allNames(out)).toEqual(["step-2", "step-3"]);
  });

  it("does not mutate a caller's usedNames set", () => {
    const used = new Set(["check"]);
    instantiate(acceptanceBody(), { usedNames: used });
    expect([...used]).toEqual(["check"]);
  });
});

describe("instantiate — insert socket", () => {
  it("wraps a 2+-node body in a fresh sequence for a single-node slot", () => {
    const out = instantiate(acceptanceBody(), { socket: "single" });
    expect(out).toHaveLength(1);
    const seq = out[0] as Extract<WorkflowNode, { type: "sequence" }>;
    expect(seq.type).toBe("sequence");
    expect(seq.id).toMatch(UUID_V4);
    expect(seq.name).toBe("sequence");
    expect(seq.body).toHaveLength(2);
    expect(allNames(seq.body)).toEqual(["activity", "check", "approve", "reject"]);
  });

  it("inserts a one-node body bare into a single-node slot", () => {
    const body: WorkflowNode[] = [{ type: "prompt", id: UUID, name: "solo", prompt: "x" } as WorkflowNode];
    const out = instantiate(body, { socket: "single" });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("prompt");
  });

  it("splices a 2+-node body directly for a list socket (the default)", () => {
    const out = instantiate(acceptanceBody(), { socket: "list" });
    expect(out).toHaveLength(2);
    expect(out.map((n) => n.type)).toEqual(["prompt", "branch"]);
  });

  it("uniquifies the wrapper sequence name against the target", () => {
    const out = instantiate(acceptanceBody(), { socket: "single", usedNames: ["sequence"] });
    expect((out[0] as WorkflowNode).name).toBe("sequence-2");
  });
});

describe("instantiateWorkflow — a whole-workflow copy with a fresh identity", () => {
  const TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";

  function template(): WorkflowFile {
    return {
      format: FORMAT_VERSION,
      id: TEMPLATE_ID,
      name: "nightly",
      input: { ticket: "PATH-1", depth: 2 },
      worker_defaults: { prompt: "claude" },
      body: acceptanceBody(),
    };
  }

  it("re-mints the workflow id and every node id", () => {
    const out = instantiateWorkflow(template());
    expect(out.id).toMatch(UUID_V4);
    expect(out.id).not.toBe(TEMPLATE_ID);
    const ids = allIds(out.body);
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4);
      expect(id).not.toBe(UUID);
    }
    expect(new Set([out.id, ...ids]).size).toBe(5);
  });

  it("carries input, worker_defaults, name and node content across verbatim", () => {
    const out = instantiateWorkflow(template());
    expect(out.format).toBe(FORMAT_VERSION);
    expect(out.name).toBe("nightly");
    expect(out.input).toEqual({ ticket: "PATH-1", depth: 2 });
    expect(out.worker_defaults).toEqual({ prompt: "claude" });
    expect(allNames(out.body)).toEqual(["activity", "check", "approve", "reject"]);
    expect((out.body[0] as { prompt: string }).prompt).toBe("Do the thing");
  });

  it("never mutates or shares structure with the template", () => {
    const source = template();
    const before = structuredClone(source);
    const out = instantiateWorkflow(source);
    expect(source).toEqual(before);
    (out.input as { ticket: string }).ticket = "changed";
    (out.worker_defaults as Record<string, string>)["prompt"] = "changed";
    expect(source).toEqual(before);
  });
});
