import type { BinaryStep, CheckpointNode, PromptStep, RunRecord, RunStatus, WorkflowFile, WorkflowNode, WorkflowStep } from "@path/schema";
import { FORMAT_VERSION } from "@path/schema";
import { describe, expect, it } from "vitest";
import { planReuse } from "../src/plan-reuse.js";

function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "root",
    worker: null,
    startedAt: "t0",
    finishedAt: null,
    inputRef: null,
    outputRef: null,
    usage: null,
    estimatedCostUsd: null,
    resumedFromRootRunId: null,
    ...overrides,
  };
}

const root = (overrides: Partial<RunRecord> = {}) => run({ runId: "root", parentRunId: null, nodeId: null, status: "succeeded", ...overrides });

function tree(body: WorkflowNode[]): WorkflowFile {
  return { format: FORMAT_VERSION, name: "t", worker: { type: "engine" }, body };
}

function prompt(id: string, overrides: Partial<PromptStep> = {}): PromptStep {
  return { type: "prompt", id, prompt: "say hi", ...overrides };
}

function binary(id: string, overrides: Partial<BinaryStep> = {}): BinaryStep {
  return { type: "binary", id, command: "echo", ...overrides };
}

function workflow(id: string, ref = "./nested.workflow.json"): WorkflowStep {
  return { type: "workflow", id, ref };
}

function checkpoint(id: string): CheckpointNode {
  return { type: "checkpoint", id, condition: { type: "exists", path: "context.ok" } };
}

describe("planReuse (#170)", () => {
  it("reuses an unchanged node id with succeeded status", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greet")]));

    expect(plan.get("greet")).toBe(originalRuns[1]);
  });

  it("leaves a renamed or removed node id unmatched, so it reruns fresh", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greeting")]));

    expect(plan.has("greeting")).toBe(false);
    expect(plan.size).toBe(0);
  });

  it("leaves an added node id unmatched, so it runs fresh", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", status: "succeeded" })];
    const plan = planReuse(originalRuns, tree([prompt("greet"), prompt("summarize")]));

    expect(plan.has("greet")).toBe(true);
    expect(plan.has("summarize")).toBe(false);
  });

  it("does not care about order — reordering an existing id changes nothing about the lookup", () => {
    const originalRuns = [
      root(),
      run({ runId: "a-run", parentRunId: "root", nodeId: "a", status: "succeeded" }),
      run({ runId: "b-run", parentRunId: "root", nodeId: "b", status: "succeeded" }),
    ];
    const forward = planReuse(originalRuns, tree([prompt("a"), prompt("b")]));
    const reversed = planReuse(originalRuns, tree([prompt("b"), prompt("a")]));

    expect(forward.get("a")).toBe(reversed.get("a"));
    expect(forward.get("b")).toBe(reversed.get("b"));
  });

  it.each(["pending", "running", "cancelled", "failed"] as RunStatus[])(
    "reruns a %s node identically to every other non-succeeded status",
    (status) => {
      const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", status })];
      const plan = planReuse(originalRuns, tree([prompt("greet")]));

      expect(plan.has("greet")).toBe(false);
    },
  );

  it("a succeeded workflow-run collapses its whole subtree without inspecting descendants", () => {
    const originalRuns = [
      root(),
      run({ runId: "revise-run", parentRunId: "root", nodeId: "revise", status: "succeeded" }),
      // Same node id as a *different* top-level step below, but nested inside the collapsed
      // workflow-run's own subtree (parentRunId is the workflow-run, not root) — ids are unique
      // only within one file, so this must never satisfy the top-level lookup for "greet".
      run({ runId: "nested-greet", parentRunId: "revise-run", nodeId: "greet", status: "succeeded" }),
    ];
    const plan = planReuse(originalRuns, tree([prompt("greet"), workflow("revise")]));

    expect(plan.get("revise")).toBe(originalRuns[1]);
    expect(plan.has("greet")).toBe(false);
  });

  it("matches on node id and status alone — config/step-body changes reaching a succeeded node change nothing", () => {
    const originalRuns = [root(), run({ runId: "greet", parentRunId: "root", nodeId: "greet", status: "succeeded" })];
    const changed = prompt("greet", { prompt: "a completely different prompt", config: { model: "different" } });
    const plan = planReuse(originalRuns, tree([changed]));

    expect(plan.get("greet")).toBe(originalRuns[1]);
  });

  it("walks into branch/parallel/while-do bodies, which never have a run row of their own", () => {
    const originalRuns = [
      root(),
      run({ runId: "a-run", parentRunId: "root", nodeId: "in-branch", status: "succeeded" }),
      run({ runId: "b-run", parentRunId: "root", nodeId: "in-parallel", status: "succeeded" }),
      run({ runId: "c-run", parentRunId: "root", nodeId: "in-loop", status: "succeeded" }),
    ];
    const nested = tree([
      { type: "branch", id: "b1", arms: [{ when: { type: "exists", path: "context.x" }, body: [prompt("in-branch")] }] },
      { type: "parallel", id: "p1", join: "collect", branches: [{ id: "br1", body: [binary("in-parallel")] }] },
      { type: "while-do", id: "w1", condition: { type: "exists", path: "context.x" }, max_iterations: 3, body: [prompt("in-loop")] },
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
      run({ runId: "iter-1", parentRunId: "root", nodeId: "revise", status: "succeeded" }),
      run({ runId: "iter-2", parentRunId: "root", nodeId: "revise", status: "succeeded" }),
    ];
    const loop = tree([
      { type: "while-do", id: "w1", condition: { type: "exists", path: "context.x" }, max_iterations: 3, body: [prompt("revise")] },
    ]);

    expect(planReuse(originalRuns, loop).has("revise")).toBe(false);
  });

  it("returns an empty plan when the original tree has no root run recorded", () => {
    expect(planReuse([], tree([prompt("greet")])).size).toBe(0);
  });
});
