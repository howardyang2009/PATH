import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BranchNode, CheckpointNode, JsonValue, WhileDoNode, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmWorker, PromptRequest } from "../src/llm/llm-worker.js";
import { createProcessorSemaphore } from "../src/llm/processor-semaphore.js";
import { createEmitter } from "../src/run-emitter.js";
import type { Observation } from "../src/run-observer.js";
import { runNode, runSequence } from "../src/run-workflow.js";
import type { NodeExecContext, RunContext } from "../src/run-context.js";

/**
 * The node seam, called directly. Every kind of node a body can hold goes through `runNode`, so
 * every kind is reachable here — including the three step types, which until this seam existed were
 * private and could only be reached by driving a whole `runWorkflow` (#76 pulled the control nodes
 * to module scope and stopped there, leaving `branch` testable and `binary` not, though a body may
 * hold either in the same position).
 */

type Node = WorkflowFile["body"][number];

const file: WorkflowFile = {
  format: "path/workflow@2",
  id: "wf-id",
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

/** A worker that records what it was asked, so a test can assert what crossed the seam. */
function recordingWorker(into: PromptRequest[]): LlmWorker {
  return {
    runPrompt: async (request) => {
      into.push(request);
      return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
    },
  };
}

/** A worker that always answers the same thing, for tests about what the engine does with it. */
function answeringWorker(output: string): LlmWorker {
  return {
    runPrompt: async () => ({ status: "succeeded", output, usage: null, estimatedCostUsd: null }),
  };
}

function makeRun(overrides: Partial<RunContext> = {}): { run: RunContext; observed: Observation[] } {
  const observed: Observation[] = [];
  // A real emitter over the capturing sink (Q7-b): the walker emits through `run.emitter`, so the
  // `observed` assertions stay assertions about the wire `Observation`s the emitter produces.
  const identity: RunContext["identity"] = { runId: "run-1", rootRunId: "run-1", parentRunId: null, nodeId: null, nodeName: null };
  const emit = async (o: Observation): Promise<void> => void observed.push(o);
  return {
    observed,
    run: {
      file,
      fileDir,
      fileConfig: {},
      identity,
      emitter: createEmitter(identity, emit),
      // An empty environment by default: a test about `$env` resolution hands over its own (#116).
      env: {},
      llm: { worker: noLlm, semaphore: createProcessorSemaphore(1) },
      detached: [],
      ...overrides,
    },
  };
}

function makeExec(context: { [key: string]: JsonValue } = {}): NodeExecContext {
  return { context, onPublish: async () => {} };
}

/** An echo step whose output is its literal input, so a sequence's chaining is visible. */
function echo(id: string, text: string): Node {
  return { type: "binary", id, name: id, command: "node", args: ["-e", `process.stdout.write(${JSON.stringify(text)})`] };
}

/**
 * A step that appends to whatever arrived on stdin — its default input, so its predecessor's output.
 * Chained, these spell out the default-input chain in the block's output: the suffixes appear in
 * exactly the order the nodes ran.
 */
function append(id: string, suffix: string): Node {
  const script = `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d+${JSON.stringify(suffix)}))`;
  return { type: "binary", id, name: id, command: "node", args: ["-e", script] };
}

describe("runNode — checkpoint", () => {
  const node: CheckpointNode = { type: "checkpoint", id: "gate", name: "gate", condition: { type: "exists", path: "context.ready" } };

  it("forwards its predecessor's output unchanged when the condition holds (§5.4)", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, node, { carried: 1 }, makeExec({ ready: true }));

    expect(outcome).toEqual({ status: "succeeded", output: { carried: 1 } });
    expect(observed.map((o) => o.type)).toEqual(["checkpoint-evaluated"]);
    expect(observed[0]).toMatchObject({ nodeId: "gate", nodeName: "gate", passed: true });
  });

  it("fails the run when the condition does not hold (§5.2), naming the checkpoint", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, node, {}, makeExec({}));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/checkpoint "gate" failed/);
    expect(observed[0]).toMatchObject({ passed: false });
  });

  // Strict semantics: a predicate that could not be evaluated is not "false", but the run stops
  // either way — the trace is what tells the two apart afterwards.
  it("fails the run when the condition errors, recording the error in the trace", async () => {
    const { run, observed } = makeRun();
    const erroring: CheckpointNode = {
      type: "checkpoint",
      id: "gate", name: "gate",
      condition: { type: "equals", path: "context.absent", value: 1 },
    };

    const outcome = await runNode(run, erroring, {}, makeExec({}));

    expect(outcome.status).toBe("failed");
    expect(observed[0]).toMatchObject({ nodeId: "gate", nodeName: "gate", passed: false, trace: expect.objectContaining({ outcome: "error" }) });
  });
});

describe("runNode — branch", () => {
  const branch = (withElse: boolean): BranchNode => ({
    type: "branch",
    id: "route", name: "route",
    arms: [
      { when: { type: "equals", path: "context.pick", value: "a" }, node: echo("arm-a", "A") },
      { when: { type: "equals", path: "context.pick", value: "b" }, node: echo("arm-b", "B") },
    ],
    ...(withElse ? { else: echo("fallback", "F") } : {}),
  });

  it("takes the first arm whose condition holds, in declaration order", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, branch(true), {}, makeExec({ pick: "b" }));

    expect(outcome).toEqual({ status: "succeeded", output: "B" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ nodeId: "route", nodeName: "route", arm: 1 });
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
    // No arm was taken, so nothing may narrate one.
    expect(observed.find((o) => o.type === "branch-taken")).toBeUndefined();
  });

  // An arm holds one node (`@2` §4.3), and a `sequence` is a legal occupant of that slot. The block
  // output is that node's output — for a `sequence`, its last child's (§5.4) — and the arm's first
  // node is seeded by the branch's predecessor, exactly as a single-step arm is.
  it("returns the taken arm's node output when that node is a sequence (§5.4)", async () => {
    const { run, observed } = makeRun();
    const node: BranchNode = {
      type: "branch",
      id: "route", name: "route",
      arms: [
        {
          when: { type: "equals", path: "context.pick", value: "a" },
          node: { type: "sequence", id: "arm-a", name: "arm-a", body: [append("a1", "-1"), append("a2", "-2")] },
        },
      ],
      else: echo("fallback", "F"),
    };

    const outcome = await runNode(run, node, "seed", makeExec({ pick: "a" }));

    expect(outcome).toEqual({ status: "succeeded", output: "seed-1-2" });
    expect(observed.find((o) => o.type === "branch-taken")).toMatchObject({ arm: 0 });
  });
});

describe("runNode — while-do", () => {
  const loop: WhileDoNode = {
    type: "while-do",
    id: "spin", name: "spin",
    condition: { type: "range", path: "context.count", max: 1 },
    max_iterations: 5,
    node: {
      type: "binary",
      id: "bump", name: "bump",
      command: "node",
      args: ["-e", "process.stdout.write(String(Number(process.argv[1]) + 1))", "${context.count}"],
      parse: "json",
      publish: { count: "${output}" },
    },
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

  // Zero iterations is not a special case — the block is transparent on the output side, forwarding
  // its predecessor's output exactly as a checkpoint does.
  it("runs zero iterations and forwards its input when the condition is false from the start", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, loop, { carried: 1 }, makeExec({ count: 9 }));

    expect(outcome).toEqual({ status: "succeeded", output: { carried: 1 } });
    expect(observed.filter((o) => o.type === "iteration-started")).toHaveLength(0);
    expect(observed.find((o) => o.type === "loop-exited")).toMatchObject({
      reason: "condition-false",
      iterations: 0,
      trace: expect.objectContaining({ outcome: "false" }),
    });
  });

  // Strict semantics again: an unevaluable condition is not a quiet exit, and the loop narrates
  // neither an iteration nor an exit — it never got as far as deciding either.
  it("fails the run when the condition evaluation errors, narrating no iteration and no exit", async () => {
    const { run, observed } = makeRun();
    const erroring: WhileDoNode = { ...loop, condition: { type: "equals", path: "context.absent", value: 1 } };

    const outcome = await runNode(run, erroring, {}, makeExec({}));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/while-do "spin"/);
    expect(observed.filter((o) => o.type === "iteration-started")).toHaveLength(0);
    expect(observed.filter((o) => o.type === "loop-exited")).toHaveLength(0);
  });

  // The cross-iteration chain over a `sequence` body (§5.4): iteration 1's node reads the block's
  // predecessor's output; iteration N's node reads iteration N−1's node's output — the *last child's*
  // when that node is a `sequence`. The suffixes spell the order out: "a" + ("*" then "!") twice.
  it("chains across iterations through a sequence body, reading the previous iteration's last child (§5.4)", async () => {
    const { run, observed } = makeRun();
    const spin: WhileDoNode = {
      type: "while-do",
      id: "spin-seq", name: "spin-seq",
      // Stop once the loop's own output carries two full passes.
      condition: { type: "not", of: { type: "matches", path: "output", pattern: "\\*!\\*!$" } },
      max_iterations: 5,
      node: { type: "sequence", id: "pass", name: "pass", body: [append("grow", "*"), append("tag", "!")] },
    };

    const outcome = await runNode(run, spin, "a", makeExec());

    expect(outcome).toEqual({ status: "succeeded", output: "a*!*!" });
    expect(observed.filter((o) => o.type === "iteration-started")).toHaveLength(2);
  });

  it("resolves an interpolated max_iterations against config before capping", async () => {
    const { run, observed } = makeRun({ fileConfig: { cap: "1" } });
    const capped: WhileDoNode = { ...loop, condition: { type: "range", path: "context.count", max: 100 }, max_iterations: "${config.cap}" };

    const outcome = await runNode(run, capped, {}, makeExec({ count: 0 }));

    // "1" resolved to the integer 1: capped after exactly one completed iteration.
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/max_iterations \(1\)/);
    expect(observed.filter((o) => o.type === "iteration-started")).toHaveLength(1);
  });

  it("fails the run when an interpolated max_iterations is not a positive integer", async () => {
    const { run, observed } = makeRun({ fileConfig: { cap: "zero" } });
    const bad: WhileDoNode = { ...loop, max_iterations: "${config.cap}" };

    const outcome = await runNode(run, bad, {}, makeExec({ count: 0 }));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(
      /while-do "spin": max_iterations resolved to "zero", which is not a positive integer/,
    );
    expect(observed).toEqual([]);
  });
});

describe("runNode — sequence", () => {
  // The `@2` logicer for "this single-node slot needs several nodes in order" (format §4.4). It adds
  // no execution rule: its output is its last child's, its first child is seeded by the `sequence`'s
  // own predecessor, and it narrates nothing of its own — the block-slot rules of §5.4, restated over
  // one node.
  it("returns its last child's output, seeding its first child from its own predecessor (§5.4)", async () => {
    const { run, observed } = makeRun();
    const node: Node = { type: "sequence", id: "steps", name: "steps", body: [append("one", "-1"), append("two", "-2")] };

    expect(await runNode(run, node, "seed", makeExec())).toEqual({ status: "succeeded", output: "seed-1-2" });
    // A logicer has no worker, task or run of its own: only its children are narrated.
    expect(observed.filter((o) => o.type === "step-started").map((o) => "nodeId" in o && o.nodeId)).toEqual(["one", "two"]);
  });

  it("chains the same way at any depth, a sequence inside a sequence included", async () => {
    const { run } = makeRun();
    const inner: Node = { type: "sequence", id: "inner", name: "inner", body: [append("a", "-a"), append("b", "-b")] };
    const outer: Node = {
      type: "sequence",
      id: "outer", name: "outer",
      body: [append("head", "-head"), inner, append("tail", "-tail")],
    };

    expect(await runNode(run, outer, "seed", makeExec())).toEqual({ status: "succeeded", output: "seed-head-a-b-tail" });
  });

  // Transparent on the context side too: a child's publish lands as that child succeeds, not buffered
  // to some sequence-level join (there is none — only `parallel` buffers, §5.3).
  it("lands a child's publish as the child succeeds, before the next child starts (§5.3)", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const landed: { [key: string]: JsonValue }[] = [];
    const node: Node = {
      type: "sequence",
      id: "steps", name: "steps",
      body: [{ ...echo("greet", "hi"), publish: { greeting: "${output}" } } as Node, append("after", "!")],
    };

    const outcome = await runNode(run, node, "seed", { ...exec, onPublish: async (u) => void landed.push(u) });

    expect(outcome).toEqual({ status: "succeeded", output: "hi!" });
    expect(exec.context).toEqual({ greeting: "hi" });
    expect(landed).toEqual([{ greeting: "hi" }]);
  });

  it("fails at its first failing child and runs nothing after it", async () => {
    const { run, observed } = makeRun();
    const node: Node = {
      type: "sequence",
      id: "steps", name: "steps",
      body: [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(3)"] }, echo("never", "x")],
    };

    const outcome = await runNode(run, node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    expect(observed.filter((o) => o.type === "step-started").map((o) => "nodeId" in o && o.nodeId)).toEqual(["boom"]);
  });
});

describe("runNode — binary step", () => {
  it("seeds a step with no input map from its predecessor's output (§6.1)", async () => {
    const { run } = makeRun();
    const echoStdin = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))";
    const node: Node = { type: "binary", id: "cat", name: "cat", command: "node", args: ["-e", echoStdin] };

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
      id: "boom", name: "boom",
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
      id: "show", name: "show",
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
    id: "ask", name: "ask",
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

  it("hands the worker an interpolated model, the step's input object, and the file's directory", async () => {
    const requests: PromptRequest[] = [];
    const { run } = makeRun({
      fileConfig: { model: "claude-opus-4-8", subject: "the release" },
      llm: { worker: recordingWorker(requests), semaphore: createProcessorSemaphore(1) },
    });
    const node: Node = {
      type: "prompt",
      id: "summarize", name: "summarize",
      prompt: "Summarize ${config.subject}.",
      input: { version: "${context.version}" },
      worker: { type: "llm", model: "${config.model}", options: { mcpServers: { docs: { type: "stdio" } } } },
    };

    expect((await runNode(run, node, "seed", makeExec({ version: "1.2.0" }))).status).toBe("succeeded");
    expect(requests[0]).toMatchObject({
      nodeName: "summarize",
      model: "claude-opus-4-8",
      prompt: "Summarize the release.",
      input: { version: "1.2.0" },
      cwd: fileDir,
    });
    // The options bag is worker-side: no engine code interprets it (§7).
    expect(requests[0]?.options).toEqual({ mcpServers: { docs: { type: "stdio" } } });
  });

  it("lets a step-level llm worker override the file's engine worker", async () => {
    const requests: PromptRequest[] = [];
    const { run } = makeRun({ llm: { worker: recordingWorker(requests), semaphore: createProcessorSemaphore(1) } });
    const node: Node = { type: "prompt", id: "ask", name: "ask", prompt: "Hi.", worker: { type: "llm", model: "claude-haiku-4-5" } };

    expect((await runNode(run, node, "seed", makeExec())).status).toBe("succeeded");
    expect(requests[0]?.model).toBe("claude-haiku-4-5");
  });

  it("applies parse: json to the processor's output", async () => {
    const { run } = makeRun({ llm: { worker: answeringWorker('{"verdict":"pass"}'), semaphore: createProcessorSemaphore(1) } });
    const node: Node = { ...(promptNode as object), parse: "json" } as Node;

    // Parsed, so the output is dot-path addressable rather than an opaque string.
    expect(await runNode(run, node, "seed", makeExec({ word: "hi" }))).toEqual({
      status: "succeeded",
      output: { verdict: "pass" },
    });
  });

  it("fails the step when the output is not the JSON its parse declares", async () => {
    const { run } = makeRun({ llm: { worker: answeringWorker("not json"), semaphore: createProcessorSemaphore(1) } });
    const node: Node = { ...(promptNode as object), id: "judge", name: "judge", parse: "json" } as Node;

    const outcome = await runNode(run, node, "seed", makeExec({ word: "hi" }));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/step "judge"/);
    expect(outcome.status === "failed" && outcome.error).toMatch(/json/i);
  });

  // A step that died mid-conversation still spent tokens, and the run row records what was spent.
  it("records what a failed processor spent, then fails the step with the worker's error", async () => {
    const worker: LlmWorker = {
      runPrompt: async () => ({
        status: "failed",
        error: 'prompt step "ask" ended with SDK result "error_max_turns"',
        usage: { input_tokens: 9 },
        estimatedCostUsd: 0.02,
      }),
    };
    const { run, observed } = makeRun({ llm: { worker, semaphore: createProcessorSemaphore(1) } });

    const outcome = await runNode(run, promptNode, "seed", makeExec({ word: "hi" }));

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/error_max_turns/);
    expect(observed.map((o) => o.type)).toEqual(["step-started", "step-usage", "step-finished"]);
    expect(observed.find((o) => o.type === "step-usage")).toMatchObject({ usage: { input_tokens: 9 }, estimatedCostUsd: 0.02 });
  });

  it("reports no usage at all for a processor that recorded none", async () => {
    const { run, observed } = makeRun({ llm: { worker: answeringWorker("ok"), semaphore: createProcessorSemaphore(1) } });

    expect((await runNode(run, promptNode, "seed", makeExec({ word: "hi" }))).status).toBe("succeeded");
    expect(observed.filter((o) => o.type === "step-usage")).toHaveLength(0);
  });

  it("spawns a fresh processor per step-run — no conversational state leaks between steps", async () => {
    const requests: PromptRequest[] = [];
    const worker: LlmWorker = {
      runPrompt: async (request) => {
        requests.push(request);
        return { status: "succeeded", output: `answered:${request.nodeName}`, usage: null, estimatedCostUsd: null };
      },
    };
    const { run } = makeRun({ llm: { worker, semaphore: createProcessorSemaphore(1) } });
    const ask = (id: string): Node => ({ type: "prompt", id, name: id, prompt: `${id} question.`, worker: { type: "llm", model: "m" } });

    const outcome = await runSequence(run, [ask("first"), ask("second")], "seed", makeExec());

    expect(outcome.status).toBe("succeeded");
    expect(requests).toHaveLength(2); // one processor per step-run, not one reused session
    // The second reads exactly what its input map built — here the default-input chain, which
    // carries the predecessor's *output*, not its conversation.
    expect(requests[1]?.input).toBe("answered:first");
  });

  it("is cancelled through the worker's signal when a sibling parallel branch fails", async () => {
    const worker: LlmWorker = {
      runPrompt: async (request) => {
        // Hold the processor open until the sibling's failure aborts it.
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "cancelled" };
      },
    };
    const { run, observed } = makeRun({ llm: { worker, semaphore: createProcessorSemaphore(2) } });
    const node: Node = {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        {
          type: "sequence", id: "slow", name: "slow",
          body: [{ type: "prompt", id: "ask", name: "ask", prompt: "Hi.", worker: { type: "llm", model: "m" }, publish: { answer: "${output}" } }],
        },
        { type: "sequence", id: "boom", name: "boom", body: [{ type: "binary", id: "fail", name: "fail", command: "node", args: ["-e", "process.exit(3)"] }] },
      ],
    };
    const exec = makeExec();

    expect((await runNode(run, node, "seed", exec)).status).toBe("failed");
    expect(observed.find((o) => o.type === "run-cancelled")).toMatchObject({ nodeId: "ask" });
    expect(observed.find((o) => o.type === "step-finished" && o.status === "cancelled")).toBeDefined();
    expect(exec.context).toEqual({});
  });
});

describe("runNode — workflow step", () => {
  const childPath = () => resolve(fileDir, "child.json");
  const child: WorkflowFile = {
    format: "path/workflow@2",
    id: "wf-id",
    name: "child",
    worker: { type: "engine" },
    body: [echo("inner", "done")],
    output: { greeting: "${context.name}" },
  };

  it("runs the referenced file as a nested run under this one, seeded only by its input", async () => {
    const { run, observed } = makeRun({ files: new Map([[childPath(), child]]) });
    const node: Node = { type: "workflow", id: "nested", name: "nested", ref: "child.json", input: { name: "world" } };

    const outcome = await runNode(run, node, "seed", makeExec({ parent_only: "invisible" }));

    expect(outcome).toEqual({ status: "succeeded", output: { greeting: "world" } });
    // The nested run is a run of its own, filed under this run and this node (#22).
    expect(observed.find((o) => o.type === "run-started")).toMatchObject({
      parentRunId: "run-1",
      nodeId: "nested", nodeName: "nested",
      input: { name: "world" },
    });
  });

  it("fails when the ref is not in the loaded tree, rather than reading the disk itself", async () => {
    const { run } = makeRun({ files: new Map() });
    const node: Node = { type: "workflow", id: "nested", name: "nested", ref: "child.json", input: {} };

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

    const outcome = await runNode(run, { type: "mystery", id: "m", name: "m" } as unknown as Node, "seed", makeExec());

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
      [echo("first", "one"), { type: "binary", id: "second", name: "second", command: "node", args: ["-e", appendTwo] }],
      "seed",
      makeExec(),
    );

    expect(outcome).toEqual({ status: "succeeded", output: "one-two" });
  });

  it("stops at the failing node and reports its cause run", async () => {
    const { run, observed } = makeRun();
    const outcome = await runSequence(
      run,
      [{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(3)"] }, echo("never", "x")],
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
