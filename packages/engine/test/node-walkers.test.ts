import type { BranchNode, CheckpointNode, JsonValue, WhileDoNode, WorkflowFile } from "@path/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessorSemaphore } from "../src/llm/processor-semaphore.js";
import type { Observation } from "../src/run-observer.js";
import {
  runBranchNode,
  runCheckpointNode,
  runSequence,
  runWhileDoNode,
  type NodeExecContext,
  type RunContext,
} from "../src/run-workflow.js";

/**
 * The node walkers, called directly. Until #76 they were nested inside a 392-line closure and
 * reachable only through a full `runWorkflow`, so the branch, loop and join semantics that carry
 * mvp spec §5.2–5.6 had no seam a test could aim at — the 1,818-line `run-workflow.test.ts` all
 * entered through one door.
 */

const file: WorkflowFile = {
  format: "path/workflow@0",
  name: "walkers",
  worker: { type: "engine" },
  body: [],
};

let fileDir: string;

beforeEach(() => {
  // Binary steps spawn with this as their cwd, so it has to exist.
  fileDir = mkdtempSync(join(tmpdir(), "path-engine-walkers-test-"));
});

afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

function makeRun(): { run: RunContext; observed: Observation[] } {
  const observed: Observation[] = [];
  return {
    observed,
    run: {
      file,
      fileDir,
      fileConfig: {},
      identity: { runId: "run-1", rootRunId: "run-1", parentRunId: null, nodeId: null },
      emit: async (o) => void observed.push(o),
      llm: {
        // No prompt steps in these fixtures; the worker is here only to satisfy the context.
        worker: { runPrompt: async () => ({ status: "failed", error: "no llm here", usage: null, estimatedCostUsd: null }) },
        semaphore: createProcessorSemaphore(1),
      },
    },
  };
}

function makeExec(context: { [key: string]: JsonValue } = {}): NodeExecContext {
  return { context, onPublish: async () => {} };
}

/** An echo step whose output is its literal input, so a sequence's chaining is visible. */
function echo(id: string, text: string): WorkflowFile["body"][number] {
  return { type: "binary", id, command: "node", args: ["-e", `process.stdout.write(${JSON.stringify(text)})`] };
}

describe("runCheckpointNode", () => {
  const node: CheckpointNode = { type: "checkpoint", id: "gate", condition: { type: "exists", path: "context.ready" } };

  it("forwards its predecessor's output unchanged when the condition holds (§5.4)", async () => {
    const { run, observed } = makeRun();
    const outcome = await runCheckpointNode(run, node, { carried: 1 }, makeExec({ ready: true }));

    expect(outcome).toEqual({ status: "succeeded", output: { carried: 1 } });
    expect(observed.map((o) => o.type)).toEqual(["checkpoint-evaluated"]);
    expect(observed[0]).toMatchObject({ nodeId: "gate", passed: true });
  });

  it("fails the run when the condition does not hold (§5.2), naming the checkpoint", async () => {
    const { run, observed } = makeRun();
    const outcome = await runCheckpointNode(run, node, {}, makeExec({}));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/checkpoint "gate" failed/);
    expect(observed[0]).toMatchObject({ passed: false });
  });
});

describe("runBranchNode", () => {
  const branch = (withElse: boolean): BranchNode => ({
    type: "branch",
    id: "route",
    arms: [
      { when: { type: "equals", path: "context.pick", value: "a" }, body: [echo("arm-a", "A")] },
      { when: { type: "equals", path: "context.pick", value: "b" }, body: [echo("arm-b", "B")] },
    ],
    ...(withElse ? { else: [echo("fallback", "F")] } : {}),
  });

  it("takes the first arm whose condition holds, in declaration order", async () => {
    const { run, observed } = makeRun();
    const outcome = await runBranchNode(run, branch(true), {}, makeExec({ pick: "b" }));

    expect(outcome).toEqual({ status: "succeeded", output: "B" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ nodeId: "route", arm: 1 });
  });

  it("takes the else fallback when no arm matches, and reports it as the arm", async () => {
    const { run, observed } = makeRun();
    const outcome = await runBranchNode(run, branch(true), {}, makeExec({ pick: "zzz" }));

    expect(outcome).toEqual({ status: "succeeded", output: "F" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ arm: "else", trace: null });
  });

  // Silent fall-through would hide an authoring bug, so it fails the run (§5.2).
  it("fails the run when nothing matches and there is no else, carrying every arm's trace", async () => {
    const { run, observed } = makeRun();
    const outcome = await runBranchNode(run, branch(false), {}, makeExec({ pick: "zzz" }));

    expect(outcome.status).toBe("failed");
    const noMatch = observed.find((o) => o.type === "branch-no-match");
    expect(noMatch).toMatchObject({ nodeId: "route" });
    expect(noMatch && "traces" in noMatch && noMatch.traces).toHaveLength(2);
  });
});

describe("runWhileDoNode", () => {
  const loop: WhileDoNode = {
    type: "while-do",
    id: "spin",
    condition: { type: "range", path: "context.count", max: 1 },
    max_iterations: 5,
    body: [
      {
        type: "binary",
        id: "bump",
        command: "node",
        args: ["-e", "process.stdout.write(String(Number(process.argv[1]) + 1))", "${context.count}"],
        parse: "json",
        publish: { count: "${output}" },
      },
    ],
  };

  it("iterates until the condition goes false, narrating each pass and the exit", async () => {
    const { run, observed } = makeRun();
    const outcome = await runWhileDoNode(run, loop, {}, makeExec({ count: 0 }));

    expect(outcome.status).toBe("succeeded");
    expect(observed.filter((o) => o.type === "iteration-started").map((o) => "iteration" in o && o.iteration)).toEqual([
      1, 2,
    ]);
    expect(observed.find((o) => o.type === "loop-exited")).toMatchObject({ reason: "condition-false", iterations: 2 });
  });

  // Exceeding the bound fails the run (§5.2/§5.6) — an unbounded loop is an authoring bug.
  it("fails the run when max_iterations is exhausted", async () => {
    const { run, observed } = makeRun();
    const outcome = await runWhileDoNode(run, { ...loop, max_iterations: 1 }, {}, makeExec({ count: 0 }));

    expect(outcome.status).toBe("failed");
    expect(observed.find((o) => o.type === "loop-exited")).toMatchObject({ reason: "max-iterations-exceeded" });
  });
});

describe("runSequence", () => {
  // A step's default input is its predecessor's output, delivered on stdin (format §4.2, §5.4).
  it("chains each node's output into the next as its default input (§5.4)", async () => {
    const { run } = makeRun();
    const appendTwo = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+'-two'))";
    const outcome = await runSequence(
      run,
      [echo("first", "one"), { type: "binary", id: "second", command: "node", args: ["-e", appendTwo] }],
      "seed",
      makeExec(),
    );

    expect(outcome).toEqual({ status: "succeeded", output: "one-two" });
  });

  it("stops at the failing node and reports its cause run", async () => {
    const { run, observed } = makeRun();
    const outcome = await runSequence(
      run,
      [{ type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(3)"] }, echo("never", "x")],
      "seed",
      makeExec(),
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.causeRunId).toBeTruthy();
    expect(observed.filter((o) => o.type === "step-started").map((o) => "nodeId" in o && o.nodeId)).toEqual(["boom"]);
  });

  // Starting a step run only to kill it would put a run in the record that never really ran.
  it("stops between nodes on an already-aborted signal, starting nothing", async () => {
    const { run, observed } = makeRun();
    const controller = new AbortController();
    controller.abort();

    const outcome = await runSequence(run, [echo("never", "x")], "seed", {
      ...makeExec(),
      signal: controller.signal,
    });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(observed.filter((o) => o.type === "step-started")).toHaveLength(0);
  });
});
