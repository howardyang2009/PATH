import { describe, expect, it } from "vitest";
import { makeWorkflowFileSchema, safeParseWorkflowFile as safeParse } from "../src/workflow-file.js";
import { builtinRegistry } from "./builtin-registry.js";

// The closed `WorkflowFileSchema` const is gone (#337): a file is validated against the open schema a
// registry builds. These envelope/invariant tests use the built-in `binary`/`prompt` grammar, so they
// build one schema from the built-in registry fixture and reuse it — the same grammar it encoded.
const WorkflowFileSchema = makeWorkflowFileSchema(builtinRegistry);

// `safeParseWorkflowFile` now requires a registry; bind the built-in one so the call sites read as
// before.
function safeParseWorkflowFile(json: unknown) {
  return safeParse(json, builtinRegistry);
}

// One valid UUIDv4. Schema checks name uniqueness across the file, not id uniqueness (ids are unique
// by construction), so a single valid GUID can stand in for every node's `id` in these fixtures.
const UUID = "11111111-1111-4111-8111-111111111111";

const minimal = {
  format: "path/workflow@4",
  id: UUID,
  name: "my-workflow",
  body: [{ type: "binary", id: UUID, name: "step-one", command: "echo" }],
};

describe("WorkflowFileSchema — envelope", () => {
  it("validates a minimal well-formed file", () => {
    expect(WorkflowFileSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects a superseded or wrong format version", () => {
    // `@4` is the only accepted format string; `@0`/`@1`/`@2`/`@3` are superseded (the loader gives a
    // targeted "run the codemod" message — see the actionable-errors block below).
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@0" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@1" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@2" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@3" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "workflow" }).success).toBe(false);
  });

  it("requires an exact format string match", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@4 " }).success).toBe(false);
  });

  it("requires a workflow-level id (the durable GUID)", () => {
    const { id, ...withoutId } = minimal;
    expect(WorkflowFileSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects a workflow id that is not a UUIDv4", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, id: "my-workflow" }).success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, bogus: true }).success).toBe(false);
  });

  it("rejects a malformed workflow name", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, name: "Not Valid" }).success).toBe(false);
  });

  it("requires a non-empty body", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, body: [] }).success).toBe(false);
  });

  it("keeps the top-level body a node array (not converted to a single node in @2)", () => {
    expect(
      WorkflowFileSchema.safeParse({
        ...minimal,
        body: [
          { type: "binary", id: UUID, name: "one", command: "echo" },
          { type: "binary", id: UUID, name: "two", command: "echo" },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects a file-level worker (a worker is a per-step name now, `@3` §4)", () => {
    // `@2` required a file-level `worker`; `@3` has none — the field is deleted, so a strict parse
    // rejects it as an unknown top-level key.
    expect(WorkflowFileSchema.safeParse({ ...minimal, worker: { type: "engine" } }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, worker: "spawn" }).success).toBe(false);
  });

  it("accepts optional config and output", () => {
    expect(
      WorkflowFileSchema.safeParse({
        ...minimal,
        config: { repo_path: "." },
        output: { file: "${context.file}" },
      }).success,
    ).toBe(true);
  });

  it("rejects the output root in the workflow-level output map (only publish maps get it)", () => {
    expect(
      WorkflowFileSchema.safeParse({
        ...minimal,
        output: { file: "${output.file}" },
      }).success,
    ).toBe(false);
  });
});

describe("WorkflowFileSchema — file-unique names", () => {
  it("rejects duplicate names across sequential body nodes", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        { type: "binary", id: UUID, name: "dup", command: "echo" },
        { type: "binary", id: UUID, name: "dup", command: "echo" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate name between a top-level node and a nested single-node body", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        { type: "binary", id: UUID, name: "dup", command: "echo" },
        {
          type: "checkpoint",
          id: UUID,
          name: "gate",
          condition: { type: "exists", path: "context.x" },
        },
        {
          type: "while-do",
          id: UUID,
          name: "loop",
          condition: { type: "exists", path: "context.x" },
          max_iterations: 2,
          node: { type: "binary", id: UUID, name: "dup", command: "echo" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate name between two parallel branch nodes", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { type: "binary", id: UUID, name: "dup", command: "echo" },
            { type: "binary", id: UUID, name: "dup", command: "echo" },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a file where every name (including parallel branch node names) is unique", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { type: "binary", id: UUID, name: "features", command: "echo" },
            { type: "binary", id: UUID, name: "fixes", command: "echo" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("WorkflowFileSchema — duplicate publish keys across parallel siblings", () => {
  it("rejects the same publish key written by two sibling branches", () => {
    const result = WorkflowFileSchema.safeParse({
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
    expect(result.success).toBe(false);
  });

  it("points the collision error at the offending branch node, not the whole branches array", () => {
    const result = safeParseWorkflowFile({
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
    expect(result.success).toBe(false);
    if (!result.success) {
      // `body.0.branches.1` — the second branch — not `body.0.branches` (the @1→@2 path-shape
      // regression that `.slice(0, -1)` would have reintroduced).
      expect(result.errors.join("\n")).toMatch(/body\.0\.branches\.1:/);
    }
  });

  it("accepts distinct publish keys across sibling branches", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { type: "binary", id: UUID, name: "a", command: "echo", publish: { a_result: "${output}" } },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { b_result: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("catches the collision even when one branch's publish is nested inside a while-do", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            {
              type: "while-do",
              id: UUID,
              name: "a",
              condition: { type: "exists", path: "context.x" },
              max_iterations: 2,
              node: { type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } },
            },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { result: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("catches the collision even when one branch's publish is nested inside a sequence", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            {
              type: "sequence",
              id: UUID,
              name: "a",
              body: [
                { type: "binary", id: UUID, name: "x1", command: "echo" },
                { type: "binary", id: UUID, name: "x2", command: "echo", publish: { result: "${output}" } },
              ],
            },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { result: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("does not flag the same publish key reused across sequential (non-parallel) steps", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        { type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } },
        { type: "binary", id: UUID, name: "y", command: "echo", publish: { result: "${output}" } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("allows the same publish key across wait-one sibling branches (only the winner lands)", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "race",
          join: "wait-one",
          branches: [
            { type: "binary", id: UUID, name: "a", command: "echo", publish: { answer: "${output}" } },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { answer: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a collect same-key collision nested inside a wait-one block", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "race",
          join: "wait-one",
          branches: [
            {
              type: "parallel",
              id: UUID,
              name: "inner",
              join: "collect",
              branches: [
                { type: "binary", id: UUID, name: "i", command: "echo", publish: { dup: "${output}" } },
                { type: "binary", id: UUID, name: "j", command: "echo", publish: { dup: "${output}" } },
              ],
            },
            { type: "binary", id: UUID, name: "b", command: "echo", publish: { dup: "${output}" } },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("does not flag the same publish key used in different parallel blocks", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p1",
          join: "collect",
          branches: [{ type: "binary", id: UUID, name: "a", command: "echo", publish: { result: "${output}" } }],
        },
        {
          type: "parallel",
          id: UUID,
          name: "p2",
          join: "collect",
          branches: [{ type: "binary", id: UUID, name: "b", command: "echo", publish: { result: "${output}" } }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("WorkflowFileSchema — do-not-wait branch may not publish", () => {
  it("accepts a do-not-wait block whose branches do not publish", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "fire",
          join: "do-not-wait",
          branches: [
            { type: "binary", id: UUID, name: "notify", command: "echo" },
            { type: "binary", id: UUID, name: "telemetry", command: "echo" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single-branch do-not-wait block (no special case)", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "fire",
          join: "do-not-wait",
          branches: [{ type: "binary", id: UUID, name: "only", command: "echo" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a publish directly inside a do-not-wait branch", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "fire",
          join: "do-not-wait",
          branches: [{ type: "binary", id: UUID, name: "notify", command: "echo", publish: { result: "${output}" } }],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/do-not-wait/);
    }
  });

  it("rejects a publish nested deeper (inside a while-do) within a do-not-wait branch", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "while-do",
              id: UUID,
              name: "notify",
              condition: { type: "exists", path: "context.x" },
              max_iterations: 2,
              node: { type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  // A `do-not-wait` branch node's publish set must be empty — its whole set, reached through a
  // `sequence` and any nesting below it, not just the `publish` written on the branch node itself.
  it("rejects a publish reached through a sequence within a do-not-wait branch", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "fire",
          join: "do-not-wait",
          branches: [
            {
              type: "sequence",
              id: UUID,
              name: "notify",
              body: [
                { type: "binary", id: UUID, name: "x1", command: "echo" },
                { type: "binary", id: UUID, name: "x2", command: "echo", publish: { result: "${output}" } },
              ],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Named, so the test cannot pass on some unrelated rejection of the file.
      expect(result.errors.join("\n")).toMatch(/do-not-wait/);
    }
  });

  it("still allows publishes in collect and wait-one blocks (the reject is do-not-wait-only)", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "collected",
          join: "collect",
          branches: [{ type: "binary", id: UUID, name: "a", command: "echo", publish: { result: "${output}" } }],
        },
        {
          type: "parallel",
          id: UUID,
          name: "raced",
          join: "wait-one",
          branches: [{ type: "binary", id: UUID, name: "b", command: "echo", publish: { answer: "${output}" } }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("safeParseWorkflowFile — actionable errors", () => {
  it("reports a readable error for an unknown field", () => {
    const result = safeParseWorkflowFile({ ...minimal, bogus: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/bogus/);
    }
  });

  it("reports a readable error for a duplicate name", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [
        { type: "binary", id: UUID, name: "dup", command: "echo" },
        { type: "binary", id: UUID, name: "dup", command: "echo" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/dup/);
      expect(result.errors.join("\n")).toMatch(/duplicate/i);
    }
  });

  it("reports a readable error for a misspelled config wrapper, dot-pathed to the value", () => {
    // The worked example in the format doc (§8.3) — pinned here because that is the text an author
    // reads when a `$env` typo would otherwise have handed the worker the wrapper.
    const result = safeParseWorkflowFile({ ...minimal, config: { token: { $evn: "TOKEN" } } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        'config.token: "$evn" is a reserved key — a sole "$"-prefixed key names a config wrapper (known: "$secret", "$env")',
      ]);
    }
  });

  // `@0` names its whole codemod chain, in order (§1): each script migrates one step and nothing
  // else, so it would report "skipped" on a file two or three versions behind and leave it exactly as
  // unreadable as it was.
  it("reports the spec §1 targeted error for a superseded @0 file, naming every codemod in order", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        "path/workflow@0 is no longer read — run scripts/migrate-workflow-format-v1.ts then scripts/migrate-workflow-format-v2.ts then scripts/migrate-workflow-format-v3.ts then scripts/migrate-workflow-format-v4.ts to migrate this file to path/workflow@4",
      ]);
    }
  });

  it("reports the spec §1 targeted error for a superseded @1 file", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        "path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts then scripts/migrate-workflow-format-v3.ts then scripts/migrate-workflow-format-v4.ts to migrate this file to path/workflow@4",
      ]);
    }
  });

  it("reports the spec §1 targeted error for a superseded @2 file", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@2" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        "path/workflow@2 is no longer read — run scripts/migrate-workflow-format-v3.ts then scripts/migrate-workflow-format-v4.ts to migrate this file to path/workflow@4",
      ]);
    }
  });

  it("reports the spec §1 targeted error for a superseded @3 file", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@3" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual([
        "path/workflow@3 is no longer read — run scripts/migrate-workflow-format-v4.ts to migrate this file to path/workflow@4",
      ]);
    }
  });

  it("reports a readable error for bad ${} syntax in a disallowed position", () => {
    // A registry leaf's own fields are plain zod now (#337), so the bad-root check lives on the core
    // grammar the file schema still owns — here the file `output` map, `interpolatedJsonValue(STEP_ROOTS)`:
    // `output` is not a STEP root, so referencing it is a load error naming the root.
    const result = safeParseWorkflowFile({
      ...minimal,
      output: { bad: "${output.cmd}" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/root/i);
    }
  });

  it("returns the parsed data on success", () => {
    const result = safeParseWorkflowFile(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("my-workflow");
    }
  });
});

// The file channel of ADR 0044's two-channel registry-relative validation (#516). Shape is checked in
// the registry-agnostic base schema (`z.record(min(1), min(1))`); *registry-relative* validity — the
// named type exists and ships the named worker — is this whole-file refinement, fed by the registry
// captured by closure. A bad entry makes the file invalid at load, so discovery reports it and the
// Designer refuses to open it. The launch channel (`--worker-default`) is a separate boundary (#506).
describe("WorkflowFileSchema — worker_defaults registry validation (ADR 0044, #516)", () => {
  it("accepts a worker_defaults naming a real type and a worker it ships", () => {
    // `prompt` ships `anthropic`; `binary` ships `spawn` — both are real (type, worker) selections.
    const result = safeParseWorkflowFile({ ...minimal, worker_defaults: { prompt: "anthropic", binary: "spawn" } });
    expect(result.success).toBe(true);
  });

  it("fails a worker_defaults key naming an unknown step type, naming the type and the installed list", () => {
    const result = safeParseWorkflowFile({ ...minimal, worker_defaults: { nope: "anthropic" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/unknown step type "nope"/);
      // The installed list, the unknown-`type` node-error shape.
      expect(joined).toMatch(/binary/);
      expect(joined).toMatch(/prompt/);
      // Attributed to the offending table entry, not the whole file.
      expect(joined).toMatch(/worker_defaults\.nope/);
    }
  });

  it("fails a worker_defaults value naming a worker the type does not ship, listing the shipped names", () => {
    // `prompt` ships only `anthropic`; `deepseek` is not one of its workers.
    const result = safeParseWorkflowFile({ ...minimal, worker_defaults: { prompt: "deepseek" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/unknown worker "deepseek"/);
      expect(joined).toMatch(/"prompt" ships "anthropic"/);
      expect(joined).toMatch(/worker_defaults\.prompt/);
    }
  });

  it("reports every bad entry in one pass (aggregate)", () => {
    const result = safeParseWorkflowFile({ ...minimal, worker_defaults: { nope: "anthropic", prompt: "deepseek" } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/unknown step type "nope"/);
      expect(joined).toMatch(/unknown worker "deepseek"/);
    }
  });
});
