import { describe, expect, it } from "vitest";
import { WorkflowFileSchema, safeParseWorkflowFile } from "../src/workflow-file.js";

// One valid UUIDv4. Schema checks name uniqueness across the file, not id uniqueness (ids are unique
// by construction), so a single valid GUID can stand in for every node's `id` in these fixtures.
const UUID = "11111111-1111-4111-8111-111111111111";

const minimal = {
  format: "path/workflow@1",
  id: UUID,
  name: "my-workflow",
  worker: { type: "engine" },
  body: [{ type: "binary", id: UUID, name: "step-one", command: "echo" }],
};

describe("WorkflowFileSchema — envelope", () => {
  it("validates a minimal well-formed file", () => {
    expect(WorkflowFileSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects a wrong format version", () => {
    // `@0` is the pre-identity format; the schema rejects it (the loader gives a targeted message).
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@0" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "workflow" }).success).toBe(false);
  });

  it("requires an exact format string match", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@1 " }).success).toBe(false);
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

  it("requires worker at workflow level", () => {
    const { worker, ...withoutWorker } = minimal;
    expect(WorkflowFileSchema.safeParse(withoutWorker).success).toBe(false);
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

  it("rejects a duplicate name between a top-level node and a nested block node", () => {
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
          body: [{ type: "binary", id: UUID, name: "dup", command: "echo" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate name between a parallel branch name and a node name", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { id: UUID, name: "dup", body: [{ type: "binary", id: UUID, name: "x", command: "echo" }] },
            { id: UUID, name: "dup", body: [{ type: "binary", id: UUID, name: "y", command: "echo" }] },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a file where every name (including parallel branch names) is unique", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: UUID,
          name: "p",
          join: "collect",
          branches: [
            { id: UUID, name: "features", body: [{ type: "binary", id: UUID, name: "x", command: "echo" }] },
            { id: UUID, name: "fixes", body: [{ type: "binary", id: UUID, name: "y", command: "echo" }] },
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
            {
              id: UUID,
              name: "a",
              body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } }],
            },
            {
              id: UUID,
              name: "b",
              body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { result: "${output}" } }],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
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
            {
              id: UUID,
              name: "a",
              body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { a_result: "${output}" } }],
            },
            {
              id: UUID,
              name: "b",
              body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { b_result: "${output}" } }],
            },
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
              id: UUID,
              name: "a",
              body: [
                {
                  type: "while-do",
                  id: UUID,
                  name: "loop",
                  condition: { type: "exists", path: "context.x" },
                  max_iterations: 2,
                  body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } }],
                },
              ],
            },
            {
              id: UUID,
              name: "b",
              body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { result: "${output}" } }],
            },
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
            { id: UUID, name: "a", body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { answer: "${output}" } }] },
            { id: UUID, name: "b", body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { answer: "${output}" } }] },
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
              id: UUID,
              name: "a",
              body: [
                {
                  type: "parallel",
                  id: UUID,
                  name: "inner",
                  join: "collect",
                  branches: [
                    { id: UUID, name: "i", body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { dup: "${output}" } }] },
                    { id: UUID, name: "j", body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { dup: "${output}" } }] },
                  ],
                },
              ],
            },
            { id: UUID, name: "b", body: [{ type: "binary", id: UUID, name: "z", command: "echo", publish: { dup: "${output}" } }] },
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
          branches: [
            { id: UUID, name: "a", body: [{ type: "binary", id: UUID, name: "x", command: "echo", publish: { result: "${output}" } }] },
          ],
        },
        {
          type: "parallel",
          id: UUID,
          name: "p2",
          join: "collect",
          branches: [
            { id: UUID, name: "b", body: [{ type: "binary", id: UUID, name: "y", command: "echo", publish: { result: "${output}" } }] },
          ],
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

  it("reports a targeted error naming the codemod for a legacy @0 file", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join("\n")).toMatch(/path\/workflow@0/);
      expect(result.errors.join("\n")).toMatch(/codemod/i);
    }
  });

  it("reports a readable error for bad ${} syntax in a disallowed position", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [{ type: "binary", id: UUID, name: "step-one", command: "${output.cmd}" }],
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
