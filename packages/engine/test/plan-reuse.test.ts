import type { BinaryStep, CheckpointNode, PromptStep, RunRecord, RunStatus, WorkflowFile, WorkflowNode, WorkflowStep } from "@path/schema";
import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import { findNestedCounterpart, pickReusedWaitOneWinner, planReuse, type ReusePlan } from "../src/plan-reuse.js";

type ParallelNode = Extract<WorkflowFile["body"][number], { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "root",
    nodeName: overrides.nodeId,
    worker: null,
    startedAt: "t0",
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    reusedFromRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...overrides,
  };
}

const root = (overrides: Partial<RunRecord> = {}) => run({ runId: "root", parentRunId: null, nodeId: null, nodeName: null, status: "succeeded", ...overrides });

function tree(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, id: "11111111-1111-4111-8111-111111111111", name: "t", worker: { type: "engine" }, body };
}

function prompt(id: string, overrides: Partial<PromptStep> = {}): PromptStep {
  return { type: "prompt", id, name: id, prompt: "say hi", ...overrides };
}

function binary(id: string, overrides: Partial<BinaryStep> = {}): BinaryStep {
  return { type: "binary", id, name: id, command: "echo", ...overrides };
}

function workflow(id: string, ref = "./nested.workflow.json"): WorkflowStep {
  return { type: "workflow", id, name: id, ref };
}

function checkpoint(id: string): CheckpointNode {
  return { type: "checkpoint", id, name: id, condition: { type: "exists", path: "context.ok" } };
}

describe("planReuse (#170)", () => {
  it("reuses an unchanged node id with succeeded status", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", nodeName: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greet")]));

    expect(plan.get("greet")).toBe(originalRuns[1]);
  });

  it("leaves a renamed or removed node id unmatched, so it reruns fresh", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", nodeName: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greeting")]));

    expect(plan.has("greeting")).toBe(false);
    expect(plan.size).toBe(0);
  });

  it("leaves an added node id unmatched, so it runs fresh", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", nodeName: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greet"), prompt("summarize")]));

    expect(plan.has("greet")).toBe(true);
    expect(plan.has("summarize")).toBe(false);
  });

  it("does not care about order — reordering an existing id changes nothing about the lookup", () => {
    const originalRuns = [
      root(),
      run({ runId: "a-run", parentRunId: "root", nodeId: "a", nodeName: "a", status: "succeeded" }),
      run({ runId: "b-run", parentRunId: "root", nodeId: "b", nodeName: "b", status: "succeeded" }),
    ];
    const forward = planReuse(originalRuns, tree([prompt("a"), prompt("b")]));
    const reversed = planReuse(originalRuns, tree([prompt("b"), prompt("a")]));

    expect(forward.get("a")).toBe(reversed.get("a"));
    expect(forward.get("b")).toBe(reversed.get("b"));
  });

  it.each(["pending", "running", "cancelled", "failed"] as RunStatus[])(
    "reruns a %s node identically to every other non-succeeded status",
    (status) => {
      const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", nodeName: "greet", status })];
      const plan = planReuse(originalRuns, tree([prompt("greet")]));

      expect(plan.has("greet")).toBe(false);
    },
  );

  it("a succeeded workflow-run collapses its whole subtree without inspecting descendants", () => {
    const originalRuns = [
      root(),
      run({ runId: "revise-run", parentRunId: "root", nodeId: "revise", nodeName: "revise", status: "succeeded" }),
      // Same node id as a *different* top-level step below, but nested inside the collapsed
      // workflow-run's own subtree (parentRunId is the workflow-run, not root) — ids are unique
      // only within one file, so this must never satisfy the top-level lookup for "greet".
      run({ runId: "nested-greet", parentRunId: "revise-run", nodeId: "greet", nodeName: "greet", status: "succeeded" }),
    ];
    const plan = planReuse(originalRuns, tree([prompt("greet"), workflow("revise")]));

    expect(plan.get("revise")).toBe(originalRuns[1]);
    expect(plan.has("greet")).toBe(false);
  });

  it("matches on node id and status alone — config/step-body changes reaching a succeeded node change nothing", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", nodeName: "greet", status: "succeeded" })];
    const changed = prompt("greet", { prompt: "a completely different prompt", config: { model: "different" } });
    const plan = planReuse(originalRuns, tree([changed]));

    expect(plan.get("greet")).toBe(originalRuns[1]);
  });

  it("walks into branch/parallel/while-do bodies, which never have a run row of their own", () => {
    const originalRuns = [
      root(),
      run({ runId: "a-run", parentRunId: "root", nodeId: "in-branch", nodeName: "in-branch", status: "succeeded" }),
      run({ runId: "b-run", parentRunId: "root", nodeId: "in-parallel", nodeName: "in-parallel", status: "succeeded" }),
      run({ runId: "c-run", parentRunId: "root", nodeId: "in-loop", nodeName: "in-loop", status: "succeeded" }),
    ];
    const nested = tree([
      { type: "branch", id: "b1", name: "b1", arms: [{ when: { type: "exists", path: "context.x" }, node: prompt("in-branch") }] },
      { type: "parallel", id: "p1", name: "p1", join: "collect", branches: [{ type: "sequence", id: "br1", name: "br1", body: [binary("in-parallel")] }] },
      { type: "while-do", id: "w1", name: "w1", condition: { type: "exists", path: "context.x" }, max_iterations: 3, node: prompt("in-loop") },
      checkpoint("cp1"),
    ]);

    const plan = planReuse(originalRuns, nested);

    expect(plan.get("in-branch")).toBe(originalRuns[1]);
    expect(plan.get("in-parallel")).toBe(originalRuns[2]);
    expect(plan.get("in-loop")).toBe(originalRuns[3]);
    expect(plan.has("cp1")).toBe(false);
    expect(plan.has("b1")).toBe(false);
    expect(plan.has("p1")).toBe(false);
    expect(plan.has("w1")).toBe(false);
  });

  it("does not reuse a node id with more than one succeeded row — a while-do body's id repeats per iteration, so which attempt answers it is undefined", () => {
    const originalRuns = [
      root(),
      run({ runId: "iter-1", parentRunId: "root", nodeId: "revise", nodeName: "revise", status: "succeeded" }),
      run({ runId: "iter-2", parentRunId: "root", nodeId: "revise", nodeName: "revise", status: "succeeded" }),
    ];
    const loop = tree([
      { type: "while-do", id: "w1", name: "w1", condition: { type: "exists", path: "context.x" }, max_iterations: 3, node: prompt("revise") },
    ]);

    expect(planReuse(originalRuns, loop).has("revise")).toBe(false);
  });

  it("returns an empty plan when the original tree has no root run recorded", () => {
    expect(planReuse([], tree([prompt("greet")])).size).toBe(0);
  });
});

// In `@2` a branch is a single node; a multi-node branch is a `sequence` carrying the branch's name
// (the collect/wait-one output key), which is exactly the shape the codemod would emit here.
function branch(name: string, body: WorkflowNode[]): ParallelBranch {
  return { type: "sequence", id: name, name, body };
}

function waitOne(branches: ParallelBranch[]): ParallelNode {
  return { type: "parallel", id: "p1", name: "p1", join: "wait-one", branches };
}

describe("findNestedCounterpart (#172)", () => {
  const originalRuns = [
    root(),
    run({ runId: "revise-run", parentRunId: "root", nodeId: "revise", nodeName: "revise", status: "succeeded" }),
    run({ runId: "greet-run", parentRunId: "revise-run", nodeId: "greet", nodeName: "greet", status: "succeeded" }),
  ];

  it("re-enters the one run matching (counterpart, node id)", () => {
    expect(findNestedCounterpart(originalRuns, "revise-run", "greet")).toBe(originalRuns[2]);
  });

  it("starts fresh (undefined) when the re-entering run has no counterpart", () => {
    expect(findNestedCounterpart(originalRuns, undefined, "greet")).toBeUndefined();
  });

  it("starts fresh when the node id was added since — no match under this counterpart", () => {
    expect(findNestedCounterpart(originalRuns, "revise-run", "summarize")).toBeUndefined();
  });

  it("starts fresh when more than one run shares (counterpart, node id) — which attempt is undefined", () => {
    const perIteration = [
      ...originalRuns,
      run({ runId: "greet-run-2", parentRunId: "revise-run", nodeId: "greet", nodeName: "greet", status: "succeeded" }),
    ];
    expect(findNestedCounterpart(perIteration, "revise-run", "greet")).toBeUndefined();
  });
});

describe("pickReusedWaitOneWinner — replaying a decided wait-one race (§7)", () => {
  // A branch reuses iff its lone run-producing node is in the plan; a plan holds the recorded run
  // (with its `finishedAt`) the branch's step reused.
  const reused = (nodeId: string, finishedAt: string | null): [string, RunRecord] => [
    nodeId,
    run({ runId: `${nodeId}-run`, parentRunId: "root", nodeId, nodeName: nodeId, status: "succeeded", finishedAt }),
  ];

  it("returns the sole reused winner directly; the losers left no plan entry", () => {
    const node = waitOne([branch("a", [prompt("a-node")]), branch("b", [prompt("b-node")])]);
    const plan: ReusePlan = new Map([reused("a-node", "t1")]);

    expect(pickReusedWaitOneWinner(node, plan)?.name).toBe("a");
  });

  it("crowns no winner when no branch is fully reused", () => {
    const node = waitOne([branch("a", [prompt("a-node")]), branch("b", [prompt("b-node")])]);
    expect(pickReusedWaitOneWinner(node, new Map())).toBeUndefined();
  });

  it("a branch with no run-producing node is not a winner — nothing was recorded to reuse", () => {
    const node = waitOne([branch("a", [checkpoint("cp")])]);
    expect(pickReusedWaitOneWinner(node, new Map())).toBeUndefined();
  });

  it("reproduces the seq-first winner from completion time when a photo-finish reused two branches, not declaration order", () => {
    // Both branches recorded `succeeded` (async cancellation lost the race); `a` is declared first
    // but finished later (t2), so the recorded winner is `b` (finished t1) — the branch a lower `seq`
    // would have named. Declaration order must not override that.
    const node = waitOne([branch("a", [prompt("a-node")]), branch("b", [prompt("b-node")])]);
    const plan: ReusePlan = new Map([reused("a-node", "t2"), reused("b-node", "t1")]);

    expect(pickReusedWaitOneWinner(node, plan)?.name).toBe("b");
  });

  it("breaks an exact completion-time collision by declaration order — the case seq exists for but resume cannot see", () => {
    const node = waitOne([branch("a", [prompt("a-node")]), branch("b", [prompt("b-node")])]);
    const plan: ReusePlan = new Map([reused("a-node", "t1"), reused("b-node", "t1")]);

    expect(pickReusedWaitOneWinner(node, plan)?.name).toBe("a");
  });
});
