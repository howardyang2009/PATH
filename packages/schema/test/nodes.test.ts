import { describe, expect, it } from "vitest";
import { NodeArraySchema, NodeSchema } from "../src/nodes.js";

describe("step nodes", () => {
  it("validates a minimal prompt step", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "summarize", prompt: "Summarize this." }).success).toBe(
      true,
    );
  });

  it("requires prompt on a prompt step", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "summarize" }).success).toBe(false);
  });

  it("validates a full prompt step with common step fields", () => {
    const result = NodeSchema.safeParse({
      type: "prompt",
      id: "11111111-1111-4111-8111-111111111111", name: "summarize",
      worker: { type: "llm", model: "claude-sonnet-5" },
      config: { temperature: 0 },
      input: { raw_changes: "${context.raw_changes}" },
      parse: "json",
      prompt: "Summarize ${context.raw_changes}.",
      publish: { summary: "${output}" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field on a step (strict)", () => {
    expect(
      NodeSchema.safeParse({ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "summarize", prompt: "hi", bogus: true }).success,
    ).toBe(false);
  });

  it("validates a minimal binary step", () => {
    expect(
      NodeSchema.safeParse({ type: "binary", id: "11111111-1111-4111-8111-111111111111", name: "gather", command: "git", args: ["log"] }).success,
    ).toBe(true);
  });

  it("requires command on a binary step, args/cwd are optional", () => {
    expect(NodeSchema.safeParse({ type: "binary", id: "11111111-1111-4111-8111-111111111111", name: "gather" }).success).toBe(false);
    expect(NodeSchema.safeParse({ type: "binary", id: "11111111-1111-4111-8111-111111111111", name: "gather", command: "git" }).success).toBe(true);
  });

  it("validates interpolable command/args/cwd", () => {
    expect(
      NodeSchema.safeParse({
        type: "binary",
        id: "11111111-1111-4111-8111-111111111111", name: "gather",
        command: "git",
        args: ["log", "${config.commit_range}"],
        cwd: "${config.repo_path}",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed interpolation in binary fields", () => {
    expect(
      NodeSchema.safeParse({ type: "binary", id: "11111111-1111-4111-8111-111111111111", name: "gather", command: "${output.cmd}" }).success,
    ).toBe(false);
  });

  it("validates a minimal workflow step", () => {
    expect(
      NodeSchema.safeParse({ type: "workflow", id: "11111111-1111-4111-8111-111111111111", name: "revise", ref: "./revise-cycle.workflow.json" }).success,
    ).toBe(true);
  });

  it("requires ref on a workflow step and rejects absolute paths", () => {
    expect(NodeSchema.safeParse({ type: "workflow", id: "11111111-1111-4111-8111-111111111111", name: "revise" }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ type: "workflow", id: "11111111-1111-4111-8111-111111111111", name: "revise", ref: "/etc/passwd.workflow.json" }).success,
    ).toBe(false);
  });

  it("does not interpolate ref (it is not an evaluated position)", () => {
    // A literal string containing `${` is fine since ref is inert — not run through
    // interpolation-syntax checking.
    expect(
      NodeSchema.safeParse({ type: "workflow", id: "11111111-1111-4111-8111-111111111111", name: "revise", ref: "./${literal}.workflow.json" }).success,
    ).toBe(true);
  });
});

describe("control nodes reject step-only fields", () => {
  it("rejects worker/config/input/parse/publish on checkpoint", () => {
    expect(
      NodeSchema.safeParse({
        type: "checkpoint",
        id: "11111111-1111-4111-8111-111111111111", name: "gate",
        condition: { type: "exists", path: "context.x" },
        worker: { type: "engine" },
      }).success,
    ).toBe(false);
  });

  it("rejects worker/config/input/parse/publish on parallel/branch/while-do", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: "11111111-1111-4111-8111-111111111111", name: "p",
        join: "collect",
        branches: [{ id: "11111111-1111-4111-8111-111111111111", name: "a", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "x", prompt: "hi" }] }],
        publish: { x: "${output}" },
      }).success,
    ).toBe(false);
  });
});

describe("checkpoint node", () => {
  it("validates a checkpoint with only id + condition", () => {
    expect(
      NodeSchema.safeParse({
        type: "checkpoint",
        id: "11111111-1111-4111-8111-111111111111", name: "have-changes",
        condition: { type: "matches", path: "context.raw_changes", pattern: "\\S" },
      }).success,
    ).toBe(true);
  });
});

describe("parallel node", () => {
  it("validates a parallel block with collect join and non-empty branches", () => {
    const result = NodeSchema.safeParse({
      type: "parallel",
      id: "11111111-1111-4111-8111-111111111111", name: "summarize",
      join: "collect",
      branches: [
        { id: "11111111-1111-4111-8111-111111111111", name: "features", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }] },
        { id: "11111111-1111-4111-8111-111111111111", name: "fixes", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "b", prompt: "hi" }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("validates a parallel block with the wait-one join", () => {
    const result = NodeSchema.safeParse({
      type: "parallel",
      id: "11111111-1111-4111-8111-111111111111", name: "race",
      join: "wait-one",
      branches: [
        { id: "11111111-1111-4111-8111-111111111111", name: "fast", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }] },
        { id: "11111111-1111-4111-8111-111111111111", name: "slow", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "b", prompt: "hi" }] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single-branch wait-one race (branches.min(1))", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: "11111111-1111-4111-8111-111111111111", name: "race",
        join: "wait-one",
        branches: [{ id: "11111111-1111-4111-8111-111111111111", name: "only", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "x", prompt: "hi" }] }],
      }).success,
    ).toBe(true);
  });

  it("rejects a join value that is neither collect nor wait-one", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: "11111111-1111-4111-8111-111111111111", name: "p",
        join: "first-done",
        branches: [{ id: "11111111-1111-4111-8111-111111111111", name: "a", body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "x", prompt: "hi" }] }],
      }).success,
    ).toBe(false);
  });

  it("rejects empty branches array", () => {
    expect(NodeSchema.safeParse({ type: "parallel", id: "11111111-1111-4111-8111-111111111111", name: "p", join: "collect", branches: [] }).success).toBe(
      false,
    );
  });

  it("rejects a branch with an empty body", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: "11111111-1111-4111-8111-111111111111", name: "p",
        join: "collect",
        branches: [{ id: "11111111-1111-4111-8111-111111111111", name: "a", body: [] }],
      }).success,
    ).toBe(false);
  });
});

describe("branch node", () => {
  it("validates arms with when/body and an optional else", () => {
    const result = NodeSchema.safeParse({
      type: "branch",
      id: "11111111-1111-4111-8111-111111111111", name: "pick",
      arms: [
        {
          when: { type: "equals", path: "context.fmt", value: "short" },
          body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }],
        },
      ],
      else: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "b", prompt: "hi" }],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one arm", () => {
    expect(NodeSchema.safeParse({ type: "branch", id: "11111111-1111-4111-8111-111111111111", name: "pick", arms: [] }).success).toBe(false);
  });
});

describe("while-do node", () => {
  it("accepts a positive integer max_iterations", () => {
    expect(
      NodeSchema.safeParse({
        type: "while-do",
        id: "11111111-1111-4111-8111-111111111111", name: "loop",
        condition: { type: "equals", path: "context.pass", value: false },
        max_iterations: 3,
        body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }],
      }).success,
    ).toBe(true);
  });

  it("accepts an interpolable string max_iterations", () => {
    expect(
      NodeSchema.safeParse({
        type: "while-do",
        id: "11111111-1111-4111-8111-111111111111", name: "loop",
        condition: { type: "equals", path: "context.pass", value: false },
        max_iterations: "${config.max_revisions}",
        body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }],
      }).success,
    ).toBe(true);
  });

  it("rejects a non-positive max_iterations", () => {
    expect(
      NodeSchema.safeParse({
        type: "while-do",
        id: "11111111-1111-4111-8111-111111111111", name: "loop",
        condition: { type: "equals", path: "context.pass", value: false },
        max_iterations: 0,
        body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }],
      }).success,
    ).toBe(false);
  });

  it("requires max_iterations", () => {
    expect(
      NodeSchema.safeParse({
        type: "while-do",
        id: "11111111-1111-4111-8111-111111111111", name: "loop",
        condition: { type: "equals", path: "context.pass", value: false },
        body: [{ type: "prompt", id: "11111111-1111-4111-8111-111111111111", name: "a", prompt: "hi" }],
      }).success,
    ).toBe(false);
  });
});

describe("recursive nesting", () => {
  it("supports deeply nested control nodes", () => {
    const nested = {
      type: "parallel",
      id: "11111111-1111-4111-8111-111111111111", name: "outer",
      join: "collect",
      branches: [
        {
          id: "11111111-1111-4111-8111-111111111111", name: "branch-a",
          body: [
            {
              type: "while-do",
              id: "11111111-1111-4111-8111-111111111111", name: "loop",
              condition: { type: "exists", path: "context.x" },
              max_iterations: 2,
              body: [
                {
                  type: "branch",
                  id: "11111111-1111-4111-8111-111111111111", name: "inner-branch",
                  arms: [
                    {
                      when: { type: "exists", path: "context.y" },
                      body: [{ type: "checkpoint", id: "11111111-1111-4111-8111-111111111111", name: "gate", condition: { type: "exists", path: "context.y" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(NodeSchema.safeParse(nested).success).toBe(true);
  });
});

describe("NodeArraySchema", () => {
  it("rejects an empty body array", () => {
    expect(NodeArraySchema.safeParse([]).success).toBe(false);
  });

  it("rejects an unrecognized node type", () => {
    expect(NodeSchema.safeParse({ type: "loop-forever", id: "11111111-1111-4111-8111-111111111111", name: "x" }).success).toBe(false);
  });

  it("rejects a node missing id (the GUID) or name", () => {
    expect(NodeSchema.safeParse({ type: "prompt", name: "summarize", prompt: "hi" }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ type: "prompt", id: "11111111-1111-4111-8111-111111111111", prompt: "hi" }).success,
    ).toBe(false);
  });

  it("rejects a node whose id is not a UUIDv4", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: "summarize", name: "summarize", prompt: "hi" }).success).toBe(false);
  });

  it("rejects a node with a malformed name", () => {
    expect(
      NodeSchema.safeParse({
        type: "prompt",
        id: "11111111-1111-4111-8111-111111111111",
        name: "Not_Valid",
        prompt: "hi",
      }).success,
    ).toBe(false);
  });
});
