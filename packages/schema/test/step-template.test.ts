import { describe, expect, it } from "vitest";
import {
  makeStepTemplateSchema,
  safeParseStepTemplate as safeParse,
  parseStepTemplate as parse,
} from "../src/step-template.js";
import { builtinRegistry } from "./builtin-registry.js";

// A Step-Template is validated against the open node grammar a registry builds, exactly like a file
// (ADR 0048). These tests bind the built-in `binary`/`prompt` fixture once and reuse the schema, the
// way the Server binds the run-wide registry once per freeze.
const StepTemplateSchema = makeStepTemplateSchema(builtinRegistry);

function safeParseStepTemplate(json: unknown) {
  return safeParse(json, builtinRegistry);
}

// One valid UUIDv4. A template's `id` is its own identity; the inner nodes' `id`s are authoring ids,
// unique by construction here, so a single GUID stands in for every `id` in these fixtures.
const UUID = "11111111-1111-4111-8111-111111111111";

// The ADR's acceptance fixture: a prompt node followed by a `branch` controller — a real fragment, a
// step plus a top-level controller, carrying its default values inline.
const minimal = {
  format: "path/workflow@5",
  id: UUID,
  description: "Draft then branch on the review verdict",
  body: [
    { type: "prompt", id: UUID, name: "draft", prompt: "Review this diff" },
    {
      type: "branch",
      id: UUID,
      name: "verdict",
      arms: [
        {
          when: { type: "equals", path: "context.ok", value: "yes" },
          node: { type: "binary", id: UUID, name: "ship", command: "echo" },
        },
      ],
      else: { type: "binary", id: UUID, name: "hold", command: "echo" },
    },
  ],
};

describe("StepTemplateSchema — envelope", () => {
  it("validates a well-formed template (a prompt + a top-level branch)", () => {
    expect(StepTemplateSchema.safeParse(minimal).success).toBe(true);
  });

  it("validates a one-node template (`body: [node]`)", () => {
    const result = safeParseStepTemplate({
      format: "path/workflow@5",
      id: UUID,
      description: "One prompt",
      body: [{ type: "prompt", id: UUID, name: "only", prompt: "Review this diff" }],
    });
    expect(result.success).toBe(true);
  });

  it("requires the id to be a UUIDv4", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, id: "not-a-uuid" }).success).toBe(false);
  });

  it("requires an id", () => {
    const { id, ...withoutId } = minimal;
    expect(StepTemplateSchema.safeParse(withoutId).success).toBe(false);
  });

  it("requires a non-empty description", () => {
    const { description, ...withoutDescription } = minimal;
    expect(StepTemplateSchema.safeParse(withoutDescription).success).toBe(false);
    expect(StepTemplateSchema.safeParse({ ...minimal, description: "" }).success).toBe(false);
  });

  it("rejects a body with no nodes (minimum one)", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, body: [] }).success).toBe(false);
  });

  it("rejects a `name` field — the file stem is the name (strict)", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, name: "my-template" }).success).toBe(false);
  });

  it("rejects a `worker_defaults` table — that table is the target file's (strict)", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, worker_defaults: { prompt: "anthropic" } }).success).toBe(false);
  });

  it("rejects other file-level envelope keys (config/input/output) — strict", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, config: {} }).success).toBe(false);
    expect(StepTemplateSchema.safeParse({ ...minimal, input: {} }).success).toBe(false);
    expect(StepTemplateSchema.safeParse({ ...minimal, output: {} }).success).toBe(false);
  });

  it("rejects any unknown top-level field (strict)", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, bogus: true }).success).toBe(false);
  });
});

describe("StepTemplateSchema — format stamp", () => {
  it("requires the current body-grammar stamp, path/workflow@5", () => {
    expect(StepTemplateSchema.safeParse({ ...minimal, format: "path/workflow@5" }).success).toBe(true);
    expect(StepTemplateSchema.safeParse({ ...minimal, format: "workflow" }).success).toBe(false);
    expect(StepTemplateSchema.safeParse({ ...minimal, format: "path/workflow@5 " }).success).toBe(false);
  });

  it("rejects a `@2`-stamped envelope through the superseded-format path (codemod message)", () => {
    // `@2` names the body grammar this map's tickets discuss, but it is not a loadable string: the
    // superseded-format path answers it with the codemod chain, not a generic `format` mismatch.
    const result = safeParseStepTemplate({ ...minimal, format: "path/workflow@2" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/path\/workflow@2 is no longer read/);
      expect(result.errors.join("\n")).toMatch(/migrate-workflow-format-v3\.ts/);
    }
  });

  it("rejects every other superseded stamp (@0/@1/@3/@4) through the same path", () => {
    for (const format of ["path/workflow@0", "path/workflow@1", "path/workflow@3", "path/workflow@4"]) {
      const result = safeParseStepTemplate({ ...minimal, format });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errors.join("\n")).toMatch(/is no longer read/);
    }
  });

  it("rejects a newer stamp with the upgrade-PATH message (G-S-09)", () => {
    const result = safeParseStepTemplate({ ...minimal, format: "path/workflow@6" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors.join("\n")).toMatch(/path\/workflow@6 is newer than this engine reads/);
  });
});

describe("StepTemplateSchema — body is registry-relative, per-node only", () => {
  it("validates every top-level controller (parallel/branch/while-do/sequence)", () => {
    const body = [
      {
        type: "parallel",
        id: UUID,
        name: "fan",
        join: "collect",
        branches: [
          { type: "binary", id: UUID, name: "a", command: "echo" },
          { type: "binary", id: UUID, name: "b", command: "echo" },
        ],
      },
      {
        type: "while-do",
        id: UUID,
        name: "loop",
        condition: { type: "exists", path: "context.x" },
        max_iterations: 2,
        node: { type: "binary", id: UUID, name: "tick", command: "echo" },
      },
      {
        type: "sequence",
        id: UUID,
        name: "seq",
        body: [{ type: "binary", id: UUID, name: "s1", command: "echo" }],
      },
    ];
    expect(safeParseStepTemplate({ ...minimal, body }).success).toBe(true);
  });

  it("reports a template naming an unregistered step type invalid (registry-relative)", () => {
    const result = safeParseStepTemplate({
      ...minimal,
      body: [{ type: "person-activity", id: UUID, name: "ask", prompt: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  it("loads a template whose two nodes share a name — names are resolved at insert, not here", () => {
    const result = safeParseStepTemplate({
      format: "path/workflow@5",
      id: UUID,
      description: "Two same-named steps",
      body: [
        { type: "binary", id: UUID, name: "dup", command: "echo" },
        { type: "binary", id: UUID, name: "dup", command: "echo" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("loads a template whose sibling branches collide on a publish key — the check is the target file's", () => {
    const result = safeParseStepTemplate({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { type: "binary", id: UUID, name: "a", command: "echo", publish: { result: "${output}" } },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { result: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("loads an arbitrarily large template — there is no node-count bound", () => {
    const body = Array.from({ length: 12 }, (_, i) => ({
      type: "binary",
      id: UUID,
      name: `step-${i}`,
      command: "echo",
    }));
    expect(safeParseStepTemplate({ ...minimal, body }).success).toBe(true);
  });

  it("allows a relative `workflow` ref node — it resolves against the target file at instantiation", () => {
    const result = safeParseStepTemplate({
      ...minimal,
      body: [{ type: "workflow", id: UUID, name: "revise", ref: "./child.workflow.json" }],
    });
    expect(result.success).toBe(true);
  });
});

describe("parseStepTemplate", () => {
  it("returns the parsed template on a valid input", () => {
    const template = parse(minimal, builtinRegistry);
    expect(template.id).toBe(UUID);
    expect(template.body).toHaveLength(2);
  });

  it("throws with the collected errors on an invalid input", () => {
    expect(() => parse({ ...minimal, description: "" }, builtinRegistry)).toThrow(/invalid step template/);
  });
});
