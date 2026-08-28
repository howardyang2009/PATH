import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeNodeSchema, type StepPluginRegistry } from "../src/nodes.js";
import { makeWorkflowFileSchema, safeParseWorkflowFile } from "../src/workflow-file.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

// A fabricated two-worker leaf step type: two fields, one config key, two workers with `curl` the
// default. `workers` values carry a `run` the schema must never call (purity, acceptance #5).
function apiCallRegistry(): StepPluginRegistry {
  return {
    "api-call": {
      fields: { url: z.string(), method: z.string() },
      config: { timeout: z.number() },
      workers: {
        fetch: { run: () => Promise.reject(new Error("run must not be called at validation")), meters: false, needsProcessorSlot: false },
        curl: { run: () => Promise.reject(new Error("run must not be called at validation")), meters: false, needsProcessorSlot: false },
      },
      defaultWorker: "curl",
    },
  };
}

function file(body: unknown[]): unknown {
  return { format: "path/workflow@3", id: ID, name: "wf", body };
}

function apiCallNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "api-call", id: ID2, name: "call", url: "https://x", method: "GET", ...overrides };
}

describe("makeWorkflowFileSchema — plugin leaf envelope", () => {
  it("validates a workflow whose leaf type is a registry entry", () => {
    const schema = makeWorkflowFileSchema(apiCallRegistry());
    expect(schema.safeParse(file([apiCallNode()])).success).toBe(true);
  });

  it("applies .strict() to the whole member — an undeclared top-level field is rejected", () => {
    const schema = makeWorkflowFileSchema(apiCallRegistry());
    const result = schema.safeParse(file([apiCallNode({ bogus: true })]));
    expect(result.success).toBe(false);
  });

  it("requires a declared plugin field", () => {
    const schema = makeWorkflowFileSchema(apiCallRegistry());
    const result = schema.safeParse(file([{ type: "api-call", id: ID2, name: "call", url: "https://x" }]));
    expect(result.success).toBe(false);
  });

  it("leaves config open (passthrough) — an inherited key beyond the fragment passes", () => {
    const schema = makeWorkflowFileSchema(apiCallRegistry());
    const node = apiCallNode({ config: { timeout: 5, inherited: "from-ancestor" } });
    expect(schema.safeParse(file([node])).success).toBe(true);
  });
});

describe("makeWorkflowFileSchema — multi-worker selection", () => {
  const schema = makeWorkflowFileSchema(apiCallRegistry());

  it("accepts a valid worker name", () => {
    expect(schema.safeParse(file([apiCallNode({ worker: "fetch" })])).success).toBe(true);
  });

  it("rejects an unknown worker name and lists the valid names", () => {
    const result = schema.safeParse(file([apiCallNode({ worker: "telnet" })]));
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((issue) => issue.message).join("\n");
    expect(message).toContain("fetch");
    expect(message).toContain("curl");
  });

  it("accepts an absent worker (optional — the engine resolves it to the default)", () => {
    expect(schema.safeParse(file([apiCallNode()])).success).toBe(true);
  });
});

describe("makeWorkflowFileSchema — unknown / absent type", () => {
  it("echoes the bad value, lists known types, aggregates every missing type, and names the remedy", () => {
    const result = safeParseWorkflowFile(
      file([apiCallNode({ type: "foo" }), { type: "bar", id: ID3, name: "other" }]),
      apiCallRegistry(),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const joined = result.errors.join("\n");
    // Every missing type in one pass, not just the first.
    expect(joined).toContain('"foo"');
    expect(joined).toContain('"bar"');
    // Known types listed, and the folder remedy named.
    expect(joined).toContain("api-call");
    expect(joined).toContain("packages/engine/step-plugins/");
  });

  it("reports an absent type as (none) and still names the remedy", () => {
    const result = safeParseWorkflowFile(file([{ id: ID2, name: "call", url: "https://x" }]), apiCallRegistry());
    expect(result.success).toBe(false);
    if (result.success) return;
    const joined = result.errors.join("\n");
    expect(joined).toContain("(none)");
    expect(joined).toContain("packages/engine/step-plugins/");
  });
});

describe("makeNodeSchema — reserved control names", () => {
  for (const reserved of ["workflow", "parallel", "branch", "while-do", "sequence", "checkpoint"]) {
    it(`rejects a plugin key shadowing "${reserved}" loud at freeze`, () => {
      const registry: StepPluginRegistry = {
        [reserved]: { fields: {}, config: {}, workers: { only: {} }, defaultWorker: "only" },
      };
      expect(() => makeNodeSchema(registry)).toThrowError(/shadows a reserved control construct/);
    });
  }
});

describe("makeNodeSchema — freeze-time guards", () => {
  it("rejects a plugin field colliding with a common step field", () => {
    const registry: StepPluginRegistry = {
      "api-call": { fields: { config: z.number() }, config: {}, workers: { only: {} }, defaultWorker: "only" },
    };
    expect(() => makeNodeSchema(registry)).toThrowError(/collides with an envelope field/);
  });

  it("rejects a plugin field colliding with the composed discriminant", () => {
    const registry: StepPluginRegistry = {
      "api-call": { fields: { type: z.string() }, config: {}, workers: { only: {} }, defaultWorker: "only" },
    };
    expect(() => makeNodeSchema(registry)).toThrowError(/collides with an envelope field/);
  });

  it("rejects a leaf type that ships no worker", () => {
    const registry: StepPluginRegistry = {
      "api-call": { fields: {}, config: {}, workers: {}, defaultWorker: "none" },
    };
    expect(() => makeNodeSchema(registry)).toThrowError(/must ship at least one worker/);
  });

  it("never calls a worker's run during validation", () => {
    const run = vi.fn(() => Promise.reject(new Error("called")));
    const registry: StepPluginRegistry = {
      "api-call": { fields: {}, config: {}, workers: { only: { run, meters: false, needsProcessorSlot: false } }, defaultWorker: "only" },
    };
    const schema = makeWorkflowFileSchema(registry);
    expect(schema.safeParse(file([{ type: "api-call", id: ID2, name: "call" }])).success).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("makeWorkflowFileSchema — publish guards govern plugin steps", () => {
  const schema = makeWorkflowFileSchema(apiCallRegistry());

  it("rejects two collect-parallel branches (plugin steps) publishing the same key", () => {
    const node = {
      type: "parallel",
      id: ID,
      name: "par",
      join: "collect",
      branches: [
        apiCallNode({ id: ID2, name: "a", publish: { result: "done" } }),
        apiCallNode({ id: ID3, name: "b", publish: { result: "done" } }),
      ],
    };
    const result = schema.safeParse(file([node]));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain("duplicate publish key");
  });

  it("rejects a plugin step publishing inside a do-not-wait branch", () => {
    const node = {
      type: "parallel",
      id: ID,
      name: "par",
      join: "do-not-wait",
      branches: [apiCallNode({ id: ID2, name: "a", publish: { late: "done" } })],
    };
    const result = schema.safeParse(file([node]));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message).join("\n")).toContain("do-not-wait branch");
  });
});

describe("makeWorkflowFileSchema — recursion closes over the open union", () => {
  const schema = makeWorkflowFileSchema(apiCallRegistry());

  it("validates a plugin step inside a sequence body", () => {
    const node = { type: "sequence", id: ID, name: "seq", body: [apiCallNode()] };
    expect(schema.safeParse(file([node])).success).toBe(true);
  });

  it("validates a plugin step inside a parallel branch", () => {
    const node = { type: "parallel", id: ID, name: "par", join: "collect", branches: [apiCallNode()] };
    expect(schema.safeParse(file([node])).success).toBe(true);
  });

  it("validates a plugin step inside a while-do body", () => {
    const node = {
      type: "while-do",
      id: ID,
      name: "loop",
      condition: { type: "exists", path: "context.x" },
      max_iterations: 3,
      node: apiCallNode(),
    };
    expect(schema.safeParse(file([node])).success).toBe(true);
  });

  it("validates a plugin step inside a branch arm", () => {
    const node = {
      type: "branch",
      id: ID,
      name: "route",
      arms: [{ when: { type: "exists", path: "context.x" }, node: apiCallNode() }],
    };
    expect(schema.safeParse(file([node])).success).toBe(true);
  });
});
