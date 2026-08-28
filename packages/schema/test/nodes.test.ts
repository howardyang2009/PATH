import { describe, expect, it } from "vitest";
import { NodeArraySchema, NodeSchema } from "../src/nodes.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("step nodes", () => {
  it("validates a minimal prompt step", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: ID, name: "summarize", prompt: "Summarize this." }).success).toBe(
      true,
    );
  });

  it("requires prompt on a prompt step", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: ID, name: "summarize" }).success).toBe(false);
  });

  it("validates a full prompt step with common step fields", () => {
    const result = NodeSchema.safeParse({
      type: "prompt",
      id: ID, name: "summarize",
      worker: "sdk",
      config: { model: "claude-sonnet-5", temperature: 0 },
      input: { raw_changes: "${context.raw_changes}" },
      parse: "json",
      prompt: "Summarize ${context.raw_changes}.",
      publish: { summary: "${output}" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an omitted worker (the type default) and the type's own worker name (`@3` §4)", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: ID, name: "a", prompt: "hi" }).success).toBe(true);
    expect(NodeSchema.safeParse({ type: "prompt", id: ID, name: "a", worker: "sdk", prompt: "hi" }).success).toBe(true);
    expect(NodeSchema.safeParse({ type: "binary", id: ID, name: "b", worker: "spawn", command: "git" }).success).toBe(true);
  });

  it("rejects a worker name the step type does not ship, listing the valid names (ADR 0021 sub-8)", () => {
    const promptResult = NodeSchema.safeParse({ type: "prompt", id: ID, name: "a", worker: "spawn", prompt: "hi" });
    expect(promptResult.success).toBe(false);
    if (!promptResult.success) {
      expect(JSON.stringify(promptResult.error.issues)).toContain("sdk");
    }
    // `binary` ships `spawn`, not `sdk` — a step type's worker names are its own (the pair is the identity).
    expect(NodeSchema.safeParse({ type: "binary", id: ID, name: "b", worker: "sdk", command: "git" }).success).toBe(false);
  });

  it("rejects a worker on a workflow step — a workflow step runs a nested run, not a worker (`@3` §4)", () => {
    expect(
      NodeSchema.safeParse({ type: "workflow", id: ID, name: "revise", ref: "./child.workflow.json", worker: "sdk" }).success,
    ).toBe(false);
  });

  it("rejects an unknown field on a step (strict)", () => {
    expect(
      NodeSchema.safeParse({ type: "prompt", id: ID, name: "summarize", prompt: "hi", bogus: true }).success,
    ).toBe(false);
  });

  it("validates a minimal binary step", () => {
    expect(
      NodeSchema.safeParse({ type: "binary", id: ID, name: "gather", command: "git", args: ["log"] }).success,
    ).toBe(true);
  });

  it("requires command on a binary step, args/cwd are optional", () => {
    expect(NodeSchema.safeParse({ type: "binary", id: ID, name: "gather" }).success).toBe(false);
    expect(NodeSchema.safeParse({ type: "binary", id: ID, name: "gather", command: "git" }).success).toBe(true);
  });

  it("validates interpolable command/args/cwd", () => {
    expect(
      NodeSchema.safeParse({
        type: "binary",
        id: ID, name: "gather",
        command: "git",
        args: ["log", "${config.commit_range}"],
        cwd: "${config.repo_path}",
      }).success,
    ).toBe(true);
  });

  it("rejects malformed interpolation in binary fields", () => {
    expect(
      NodeSchema.safeParse({ type: "binary", id: ID, name: "gather", command: "${output.cmd}" }).success,
    ).toBe(false);
  });

  it("validates a minimal workflow step", () => {
    expect(
      NodeSchema.safeParse({ type: "workflow", id: ID, name: "revise", ref: "./revise-cycle.workflow.json" }).success,
    ).toBe(true);
  });

  it("requires ref on a workflow step and rejects absolute paths", () => {
    expect(NodeSchema.safeParse({ type: "workflow", id: ID, name: "revise" }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ type: "workflow", id: ID, name: "revise", ref: "/etc/passwd.workflow.json" }).success,
    ).toBe(false);
  });

  it("does not interpolate ref (it is not an evaluated position)", () => {
    // A literal string containing `${` is fine since ref is inert — not run through
    // interpolation-syntax checking.
    expect(
      NodeSchema.safeParse({ type: "workflow", id: ID, name: "revise", ref: "./${literal}.workflow.json" }).success,
    ).toBe(true);
  });
});

describe("logicers reject step-only fields", () => {
  it("rejects worker/config/input/parse/publish on checkpoint", () => {
    expect(
      NodeSchema.safeParse({
        type: "checkpoint",
        id: ID, name: "gate",
        condition: { type: "exists", path: "context.x" },
        worker: "spawn",
      }).success,
    ).toBe(false);
  });

  it("rejects worker/config/input/parse/publish on parallel", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: ID, name: "p",
        join: "collect",
        branches: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }],
        publish: { x: "${output}" },
      }).success,
    ).toBe(false);
  });

  it("rejects worker/config/input/parse/publish on sequence", () => {
    expect(
      NodeSchema.safeParse({
        type: "sequence",
        id: ID, name: "s",
        body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }],
        worker: "sdk",
      }).success,
    ).toBe(false);
  });
});

describe("checkpoint node", () => {
  it("validates a checkpoint with only id + condition", () => {
    expect(
      NodeSchema.safeParse({
        type: "checkpoint",
        id: ID, name: "have-changes",
        condition: { type: "matches", path: "context.raw_changes", pattern: "\\S" },
      }).success,
    ).toBe(true);
  });
});

describe("parallel node", () => {
  it("validates a parallel block whose branches are nodes carrying id + name", () => {
    const result = NodeSchema.safeParse({
      type: "parallel",
      id: ID, name: "summarize",
      join: "collect",
      branches: [
        { type: "prompt", id: ID, name: "features", prompt: "hi" },
        { type: "prompt", id: ID, name: "fixes", prompt: "hi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("validates a parallel block with the wait-one join", () => {
    const result = NodeSchema.safeParse({
      type: "parallel",
      id: ID, name: "race",
      join: "wait-one",
      branches: [
        { type: "prompt", id: ID, name: "fast", prompt: "hi" },
        { type: "prompt", id: ID, name: "slow", prompt: "hi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single-branch wait-one race (branches.min(1))", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: ID, name: "race",
        join: "wait-one",
        branches: [{ type: "prompt", id: ID, name: "only", prompt: "hi" }],
      }).success,
    ).toBe(true);
  });

  it("validates a parallel block with the do-not-wait join", () => {
    const result = NodeSchema.safeParse({
      type: "parallel",
      id: ID, name: "fire",
      join: "do-not-wait",
      branches: [
        { type: "prompt", id: ID, name: "notify", prompt: "hi" },
        { type: "prompt", id: ID, name: "telemetry", prompt: "hi" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a sequence as a branch (a branch that needs several nodes in order)", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: ID, name: "p",
        join: "collect",
        branches: [
          {
            type: "sequence",
            id: ID, name: "gather-then-summarize",
            body: [
              { type: "binary", id: ID, name: "gather", command: "git" },
              { type: "prompt", id: ID, name: "summarize", prompt: "hi" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects the deleted @1 branch wrapper { id, name, body } as a branch", () => {
    // The `@1` wrapper was not itself a node; in `@2` a branch is a node, so a bare wrapper (no
    // `type`) is rejected by the node union.
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: ID, name: "p",
        join: "collect",
        branches: [{ id: ID, name: "a", body: [{ type: "prompt", id: ID, name: "x", prompt: "hi" }] }],
      }).success,
    ).toBe(false);
  });

  it("rejects a join value that is none of collect, wait-one, or do-not-wait", () => {
    expect(
      NodeSchema.safeParse({
        type: "parallel",
        id: ID, name: "p",
        join: "first-done",
        branches: [{ type: "prompt", id: ID, name: "x", prompt: "hi" }],
      }).success,
    ).toBe(false);
  });

  it("rejects empty branches array", () => {
    expect(NodeSchema.safeParse({ type: "parallel", id: ID, name: "p", join: "collect", branches: [] }).success).toBe(
      false,
    );
  });
});

describe("branch node", () => {
  it("validates arms with when/node and an optional single-node else", () => {
    const result = NodeSchema.safeParse({
      type: "branch",
      id: ID, name: "pick",
      arms: [
        {
          when: { type: "equals", path: "context.fmt", value: "short" },
          node: { type: "prompt", id: ID, name: "a", prompt: "hi" },
        },
      ],
      else: { type: "prompt", id: ID, name: "b", prompt: "hi" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an arm carrying the @1 `body` array instead of a single `node`", () => {
    expect(
      NodeSchema.safeParse({
        type: "branch",
        id: ID, name: "pick",
        arms: [{ when: { type: "exists", path: "context.x" }, body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }] }],
      }).success,
    ).toBe(false);
  });

  it("rejects a bare-array else (else is a single node in @2)", () => {
    expect(
      NodeSchema.safeParse({
        type: "branch",
        id: ID, name: "pick",
        arms: [{ when: { type: "exists", path: "context.x" }, node: { type: "prompt", id: ID, name: "a", prompt: "hi" } }],
        else: [{ type: "prompt", id: ID, name: "b", prompt: "hi" }],
      }).success,
    ).toBe(false);
  });

  it("requires at least one arm", () => {
    expect(NodeSchema.safeParse({ type: "branch", id: ID, name: "pick", arms: [] }).success).toBe(false);
  });
});

describe("while-do node", () => {
  const loop = (extra: Record<string, unknown>) => ({
    type: "while-do",
    id: ID, name: "loop",
    condition: { type: "equals", path: "context.pass", value: false },
    node: { type: "prompt", id: ID, name: "a", prompt: "hi" },
    ...extra,
  });

  it("accepts a positive integer max_iterations", () => {
    expect(NodeSchema.safeParse(loop({ max_iterations: 3 })).success).toBe(true);
  });

  it("accepts an interpolable string max_iterations", () => {
    expect(NodeSchema.safeParse(loop({ max_iterations: "${config.max_revisions}" })).success).toBe(true);
  });

  it("rejects a non-positive max_iterations", () => {
    expect(NodeSchema.safeParse(loop({ max_iterations: 0 })).success).toBe(false);
  });

  it("requires max_iterations", () => {
    expect(NodeSchema.safeParse(loop({})).success).toBe(false);
  });

  it("rejects a bare-array `body` (the loop body is a single `node` in @2)", () => {
    expect(
      NodeSchema.safeParse({
        type: "while-do",
        id: ID, name: "loop",
        condition: { type: "equals", path: "context.pass", value: false },
        max_iterations: 3,
        body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }],
      }).success,
    ).toBe(false);
  });
});

describe("sequence node", () => {
  it("validates a sequence with a node-array body", () => {
    expect(
      NodeSchema.safeParse({
        type: "sequence",
        id: ID, name: "gather-then-summarize",
        body: [
          { type: "binary", id: ID, name: "gather", command: "git" },
          { type: "prompt", id: ID, name: "summarize", prompt: "hi" },
        ],
      }).success,
    ).toBe(true);
  });

  it("accepts a single-node body (min length 1)", () => {
    expect(
      NodeSchema.safeParse({
        type: "sequence",
        id: ID, name: "one",
        body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty body (an empty sequence is a load error)", () => {
    expect(NodeSchema.safeParse({ type: "sequence", id: ID, name: "empty", body: [] }).success).toBe(false);
  });

  it("requires id + name", () => {
    expect(NodeSchema.safeParse({ type: "sequence", body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }] }).success).toBe(
      false,
    );
  });

  it("nests — a sequence may hold a sequence", () => {
    expect(
      NodeSchema.safeParse({
        type: "sequence",
        id: ID, name: "outer",
        body: [
          {
            type: "sequence",
            id: ID, name: "inner",
            body: [{ type: "prompt", id: ID, name: "a", prompt: "hi" }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("recursive nesting", () => {
  it("supports deeply nested container slots (single nodes throughout)", () => {
    const nested = {
      type: "parallel",
      id: ID, name: "outer",
      join: "collect",
      branches: [
        {
          type: "while-do",
          id: ID, name: "loop",
          condition: { type: "exists", path: "context.x" },
          max_iterations: 2,
          node: {
            type: "branch",
            id: ID, name: "inner-branch",
            arms: [
              {
                when: { type: "exists", path: "context.y" },
                node: { type: "checkpoint", id: ID, name: "gate", condition: { type: "exists", path: "context.y" } },
              },
            ],
          },
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
    expect(NodeSchema.safeParse({ type: "loop-forever", id: ID, name: "x" }).success).toBe(false);
  });

  it("rejects a node missing id (the GUID) or name", () => {
    expect(NodeSchema.safeParse({ type: "prompt", name: "summarize", prompt: "hi" }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ type: "prompt", id: ID, prompt: "hi" }).success,
    ).toBe(false);
  });

  it("rejects a node whose id is not a UUIDv4", () => {
    expect(NodeSchema.safeParse({ type: "prompt", id: "summarize", name: "summarize", prompt: "hi" }).success).toBe(false);
  });

  it("rejects a node with a malformed name", () => {
    expect(
      NodeSchema.safeParse({
        type: "prompt",
        id: ID,
        name: "Not_Valid",
        prompt: "hi",
      }).success,
    ).toBe(false);
  });
});
