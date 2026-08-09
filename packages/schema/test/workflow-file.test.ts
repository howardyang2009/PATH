import { describe, expect, it } from "vitest";
import { WorkflowFileSchema, safeParseWorkflowFile } from "../src/workflow-file.js";

const minimal = {
  format: "path/workflow@0",
  name: "my-workflow",
  worker: { type: "engine" },
  body: [{ type: "binary", id: "step-one", command: "echo" }],
};

describe("WorkflowFileSchema — envelope", () => {
  it("validates a minimal well-formed file", () => {
    expect(WorkflowFileSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects a wrong format version", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@1" }).success).toBe(false);
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "workflow" }).success).toBe(false);
  });

  it("requires an exact format string match", () => {
    expect(WorkflowFileSchema.safeParse({ ...minimal, format: "path/workflow@0 " }).success).toBe(false);
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

describe("WorkflowFileSchema — file-unique ids", () => {
  it("rejects duplicate ids across sequential body nodes", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        { type: "binary", id: "dup", command: "echo" },
        { type: "binary", id: "dup", command: "echo" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate id between a top-level node and a nested block node", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        { type: "binary", id: "dup", command: "echo" },
        {
          type: "checkpoint",
          id: "gate",
          condition: { type: "exists", path: "context.x" },
        },
        {
          type: "while-do",
          id: "loop",
          condition: { type: "exists", path: "context.x" },
          max_iterations: 2,
          body: [{ type: "binary", id: "dup", command: "echo" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a duplicate id between a parallel branch id and a node id", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: "p",
          join: "collect",
          branches: [
            { id: "dup", body: [{ type: "binary", id: "x", command: "echo" }] },
            { id: "dup", body: [{ type: "binary", id: "y", command: "echo" }] },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a file where every id (including parallel branch ids) is unique", () => {
    const result = WorkflowFileSchema.safeParse({
      ...minimal,
      body: [
        {
          type: "parallel",
          id: "p",
          join: "collect",
          branches: [
            { id: "features", body: [{ type: "binary", id: "x", command: "echo" }] },
            { id: "fixes", body: [{ type: "binary", id: "y", command: "echo" }] },
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
          id: "p",
          join: "collect",
          branches: [
            {
              id: "a",
              body: [{ type: "binary", id: "x", command: "echo", publish: { result: "${output}" } }],
            },
            {
              id: "b",
              body: [{ type: "binary", id: "y", command: "echo", publish: { result: "${output}" } }],
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
          id: "p",
          join: "collect",
          branches: [
            {
              id: "a",
              body: [{ type: "binary", id: "x", command: "echo", publish: { a_result: "${output}" } }],
            },
            {
              id: "b",
              body: [{ type: "binary", id: "y", command: "echo", publish: { b_result: "${output}" } }],
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
          id: "p",
          join: "collect",
          branches: [
            {
              id: "a",
              body: [
                {
                  type: "while-do",
                  id: "loop",
                  condition: { type: "exists", path: "context.x" },
                  max_iterations: 2,
                  body: [{ type: "binary", id: "x", command: "echo", publish: { result: "${output}" } }],
                },
              ],
            },
            {
              id: "b",
              body: [{ type: "binary", id: "y", command: "echo", publish: { result: "${output}" } }],
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
        { type: "binary", id: "x", command: "echo", publish: { result: "${output}" } },
        { type: "binary", id: "y", command: "echo", publish: { result: "${output}" } },
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
          id: "race",
          join: "wait-one",
          branches: [
            { id: "a", body: [{ type: "binary", id: "x", command: "echo", publish: { answer: "${output}" } }] },
            { id: "b", body: [{ type: "binary", id: "y", command: "echo", publish: { answer: "${output}" } }] },
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
          id: "race",
          join: "wait-one",
          branches: [
            {
              id: "a",
              body: [
                {
                  type: "parallel",
                  id: "inner",
                  join: "collect",
                  branches: [
                    { id: "i", body: [{ type: "binary", id: "x", command: "echo", publish: { dup: "${output}" } }] },
                    { id: "j", body: [{ type: "binary", id: "y", command: "echo", publish: { dup: "${output}" } }] },
                  ],
                },
              ],
            },
            { id: "b", body: [{ type: "binary", id: "z", command: "echo", publish: { dup: "${output}" } }] },
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
          id: "p1",
          join: "collect",
          branches: [
            { id: "a", body: [{ type: "binary", id: "x", command: "echo", publish: { result: "${output}" } }] },
          ],
        },
        {
          type: "parallel",
          id: "p2",
          join: "collect",
          branches: [
            { id: "b", body: [{ type: "binary", id: "y", command: "echo", publish: { result: "${output}" } }] },
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

  it("reports a readable error for a duplicate id", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [
        { type: "binary", id: "dup", command: "echo" },
        { type: "binary", id: "dup", command: "echo" },
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

  it("reports a readable error for a wrong format version", () => {
    const result = safeParseWorkflowFile({ ...minimal, format: "path/workflow@1" });
    expect(result.success).toBe(false);
  });

  it("reports a readable error for bad ${} syntax in a disallowed position", () => {
    const result = safeParseWorkflowFile({
      ...minimal,
      body: [{ type: "binary", id: "step-one", command: "${output.cmd}" }],
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
