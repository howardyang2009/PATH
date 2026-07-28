import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BranchNode, CheckpointNode, JsonValue, WhileDoNode, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmWorker } from "../src/llm/llm-worker.js";
import { createProcessorSemaphore } from "../src/llm/processor-semaphore.js";
import type { Observation } from "../src/run-observer.js";
import { runNode, runSequence, type NodeExecContext, type RunContext } from "../src/run-workflow.js";

/**
 * The node seam, called directly. Every kind of node a body can hold goes through `runNode`, so
 * every kind is reachable here — including the three step types, which until this seam existed were
 * private and could only be reached by driving a whole `runWorkflow` (#76 pulled the control nodes
 * to module scope and stopped there, leaving `branch` testable and `binary` not, though a body may
 * hold either in the same position).
 */

type Node = WorkflowFile["body"][number];

const file: WorkflowFile = {
  format: "path/workflow@0",
  name: "walkers",
  worker: { type: "engine" },
  body: [],
};

let fileDir: string;

beforeEach(() => {
  // Binary steps spawn with this as their cwd, so it has to exist.
  fileDir = mkdtempSync(join(tmpdir(), "path-engine-run-node-test-"));
});

afterEach(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

const noLlm: LlmWorker = {
  runPrompt: async () => ({ status: "failed", error: "no llm here", usage: null, estimatedCostUsd: null }),
};

function makeRun(overrides: Partial<RunContext> = {}): { run: RunContext; observed: Observation[] } {
  const observed: Observation[] = [];
  return {
    observed,
    run: {
      file,
      fileDir,
      fileConfig: {},
      identity: { runId: "run-1", rootRunId: "run-1", parentRunId: null, nodeId: null },
      emit: async (o) => void observed.push(o),
      llm: { worker: noLlm, semaphore: createProcessorSemaphore(1) },
      ...overrides,
    },
  };
}

function makeExec(context: { [key: string]: JsonValue } = {}): NodeExecContext {
  return { context, onPublish: async () => {} };
}

/** An echo step whose output is its literal input, so a sequence's chaining is visible. */
function echo(id: string, text: string): Node {
  return { type: "binary", id, command: "node", args: ["-e", `process.stdout.write(${JSON.stringify(text)})`] };
}

describe("runNode — checkpoint", () => {
  const node: CheckpointNode = { type: "checkpoint", id: "gate", condition: { type: "exists", path: "context.ready" } };

  it("forwards its predecessor's output unchanged when the condition holds (§5.4)", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, node, { carried: 1 }, makeExec({ ready: true }));

    expect(outcome).toEqual({ status: "succeeded", output: { carried: 1 } });
    expect(observed.map((o) => o.type)).toEqual(["checkpoint-evaluated"]);
    expect(observed[0]).toMatchObject({ nodeId: "gate", passed: true });
  });

  it("fails the run when the condition does not hold (§5.2), naming the checkpoint", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, node, {}, makeExec({}));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/checkpoint "gate" failed/);
    expect(observed[0]).toMatchObject({ passed: false });
  });
});

describe("runNode — branch", () => {
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
    const outcome = await runNode(run, branch(true), {}, makeExec({ pick: "b" }));

    expect(outcome).toEqual({ status: "succeeded", output: "B" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ nodeId: "route", arm: 1 });
  });

  it("takes the else fallback when no arm matches, and reports it as the arm", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, branch(true), {}, makeExec({ pick: "zzz" }));

    expect(outcome).toEqual({ status: "succeeded", output: "F" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ arm: "else", trace: null });
  });

  // Silent fall-through would hide an authoring bug, so it fails the run (§5.2).
  it("fails the run when nothing matches and there is no else, carrying every arm's trace", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, branch(false), {}, makeExec({ pick: "zzz" }));

    expect(outcome.status).toBe("failed");
    const noMatch = observed.find((o) => o.type === "branch-no-match");
    expect(noMatch).toMatchObject({ nodeId: "route" });
    expect(noMatch && "traces" in noMatch && noMatch.traces).toHaveLength(2);
  });
});

describe("runNode — while-do", () => {
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
    const outcome = await runNode(run, loop, {}, makeExec({ count: 0 }));

    expect(outcome.status).toBe("succeeded");
    expect(observed.filter((o) => o.type === "iteration-started").map((o) => "iteration" in o && o.iteration)).toEqual([
      1, 2,
    ]);
    expect(observed.find((o) => o.type === "loop-exited")).toMatchObject({ reason: "condition-false", iterations: 2 });
  });

  // Exceeding the bound fails the run (§5.2/§5.6) — an unbounded loop is an authoring bug.
  it("fails the run when max_iterations is exhausted", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, { ...loop, max_iterations: 1 }, {}, makeExec({ count: 0 }));

    expect(outcome.status).toBe("failed");
    expect(observed.find((o) => o.type === "loop-exited")).toMatchObject({ reason: "max-iterations-exceeded" });
  });
});

describe("runNode — parallel", () => {
  const parallel = (secondBranchBody: Node[]): Node => ({
    type: "parallel",
    id: "fan",
    join: "collect",
    branches: [
      { id: "left", body: [{ ...echo("l", "L"), publish: { from_left: "${output}" } } as Node] },
      { id: "right", body: secondBranchBody },
    ],
  });

  it("keys its output by branch id in declaration order, whatever order they finish in", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, parallel([echo("r", "R")]), "seed", makeExec());

    expect(outcome).toEqual({ status: "succeeded", output: { left: "L", right: "R" } });
    expect(observed.find((o) => o.type === "join-applied")).toMatchObject({
      nodeId: "fan",
      branches: ["left", "right"],
      publishedKeys: ["from_left"],
    });
  });

  it("lands a branch's publishes only at the join, never before", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const seenDuringRun: string[] = [];
    const outcome = await runNode(
      run,
      parallel([
        {
          type: "binary",
          id: "peek",
          command: "node",
          args: ["-e", `process.stdout.write(${JSON.stringify("R")})`],
        },
      ]),
      "seed",
      { ...exec, onPublish: async (updates) => void seenDuringRun.push(...Object.keys(updates)) },
    );

    expect(outcome.status).toBe("succeeded");
    // One call, at the join — not one per branch publish as it happened.
    expect(seenDuringRun).toEqual(["from_left"]);
    expect(exec.context).toEqual({ from_left: "L" });
  });

  it("fails the block when a branch fails, naming the branch, and lands no publishes", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const outcome = await runNode(
      run,
      parallel([{ type: "binary", id: "boom", command: "node", args: ["-e", "process.exit(3)"] }]),
      "seed",
      exec,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/parallel "fan", branch "right"/);
    expect(exec.context).toEqual({});
  });
});

describe("runNode — binary step", () => {
  it("seeds a step with no input map from its predecessor's output (§6.1)", async () => {
    const { run } = makeRun();
    const echoStdin = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))";
    const node: Node = { type: "binary", id: "cat", command: "node", args: ["-e", echoStdin] };

    expect(await runNode(run, node, "carried", makeExec())).toEqual({ status: "succeeded", output: "carried" });
  });

  it("lands its publish on the run's context after it succeeds (§5.3)", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const landed: { [key: string]: JsonValue }[] = [];
    const node: Node = { ...echo("greet", "hi"), publish: { greeting: "${output}" } } as Node;

    const outcome = await runNode(run, node, "seed", { ...exec, onPublish: async (u) => void landed.push(u) });

    expect(outcome).toEqual({ status: "succeeded", output: "hi" });
    expect(exec.context).toEqual({ greeting: "hi" });
    expect(landed).toEqual([{ greeting: "hi" }]);
  });

  it("publishes nothing when the step fails", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const node: Node = {
      type: "binary",
      id: "boom",
      command: "node",
      args: ["-e", "process.exit(3)"],
      publish: { greeting: "${output}" },
    };

    expect((await runNode(run, node, "seed", exec)).status).toBe("failed");
    expect(exec.context).toEqual({});
  });

  it("merges the step's own config over the file's, nearest wins (§8)", async () => {
    const { run } = makeRun({ fileConfig: { greeting: "file", other: "kept" } });
    const node: Node = {
      type: "binary",
      id: "show",
      command: "node",
      args: ["-e", "process.stdout.write(process.argv[1] + process.argv[2])", "${config.greeting}", "${config.other}"],
      config: { greeting: "step" },
    };

    expect(await runNode(run, node, "seed", makeExec())).toEqual({ status: "succeeded", output: "stepkept" });
  });

  it("fails the step, naming it, when its input map references something that isn't there", async () => {
    const { run, observed } = makeRun();
    const node: Node = { ...echo("greet", "hi"), input: { who: "${context.missing}" } } as Node;

    const outcome = await runNode(run, node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/node "greet"/);
    // The step never started: an input that cannot be built is not a run that happened.
    expect(observed).toEqual([]);
  });
});

describe("runNode — prompt step", () => {
  const promptNode: Node = {
    type: "prompt",
    id: "ask",
    prompt: "say ${context.word}",
    worker: { type: "llm", model: "test-model" },
  };

  it("runs on the llm worker and reports what the processor spent (§5.7)", async () => {
    const prompts: string[] = [];
    const worker: LlmWorker = {
      runPrompt: async (request) => {
        prompts.push(request.prompt);
        return { status: "succeeded", output: "hello", usage: { input_tokens: 3 }, estimatedCostUsd: 0.01 };
      },
    };
    const { run, observed } = makeRun({ llm: { worker, semaphore: createProcessorSemaphore(1) } });

    const outcome = await runNode(run, promptNode, "seed", makeExec({ word: "hi" }));

    expect(outcome).toEqual({ status: "succeeded", output: "hello" });
    expect(prompts).toEqual(["say hi"]);
    expect(observed.map((o) => o.type)).toEqual(["step-started", "step-usage", "step-finished"]);
    expect(observed.find((o) => o.type === "step-usage")).toMatchObject({ estimatedCostUsd: 0.01 });
  });

  // A worker is a binding, not a suggestion: treating this as an LLM step would hide the bug.
  it("fails when its effective worker is not an llm one (§7)", async () => {
    const { run } = makeRun();
    const { worker: _dropped, ...withoutWorker } = promptNode as Extract<Node, { type: "prompt" }>;

    const outcome = await runNode(run, withoutWorker as Node, "seed", makeExec({ word: "hi" }));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/needs an llm worker/);
  });
});

describe("runNode — workflow step", () => {
  const childPath = () => resolve(fileDir, "child.json");
  const child: WorkflowFile = {
    format: "path/workflow@0",
    name: "child",
    worker: { type: "engine" },
    body: [echo("inner", "done")],
    output: { greeting: "${context.name}" },
  };

  it("runs the referenced file as a nested run under this one, seeded only by its input", async () => {
    const { run, observed } = makeRun({ files: new Map([[childPath(), child]]) });
    const node: Node = { type: "workflow", id: "nested", ref: "child.json", input: { name: "world" } };

    const outcome = await runNode(run, node, "seed", makeExec({ parent_only: "invisible" }));

    expect(outcome).toEqual({ status: "succeeded", output: { greeting: "world" } });
    // The nested run is a run of its own, filed under this run and this node (#22).
    expect(observed.find((o) => o.type === "run-started")).toMatchObject({
      parentRunId: "run-1",
      nodeId: "nested",
      input: { name: "world" },
    });
  });

  it("fails when the ref is not in the loaded tree, rather than reading the disk itself", async () => {
    const { run } = makeRun({ files: new Map() });
    const node: Node = { type: "workflow", id: "nested", ref: "child.json", input: {} };

    const outcome = await runNode(run, node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/is not in the loaded tree/);
  });
});

describe("runNode — a node type this engine does not walk", () => {
  // The compile-time `never` guard cannot see a hand-constructed file, which can reach the engine
  // without passing the schema — so it must fail loudly rather than be silently skipped.
  it("fails the run, naming the type and the node", async () => {
    const { run } = makeRun();

    const outcome = await runNode(run, { type: "mystery", id: "m" } as unknown as Node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/node type "mystery" \(node "m"\)/);
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
