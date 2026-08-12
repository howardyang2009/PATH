import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, WorkflowFile } from "@path/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmWorker } from "../src/llm/llm-worker.js";
import { createProcessorSemaphore } from "../src/llm/processor-semaphore.js";
import type { NodeExecContext, RunContext } from "../src/run-context.js";
import type { Observation } from "../src/run-observer.js";
import { runNode } from "../src/run-workflow.js";

/**
 * The `parallel` block, driven through the node seam. `runParallelNode` cannot be called in isolation
 * — a branch body is a node sequence, so it recurses back into `runSequence`/`runNode` — so these
 * exercise the block the only way it runs: `runNode` dispatching a `parallel` node. The three joins,
 * the cancellation cascade and the concurrency cap all surface here. (Detached `do-not-wait` branches
 * are covered end-to-end in `run-workflow.test.ts`, where the enclosing-run exit barrier that awaits
 * them is a `runWorkflow` concern.)
 */

type Node = WorkflowFile["body"][number];

const file: WorkflowFile = {
  format: "path/workflow@1",
  id: "wf-id",
  name: "walkers",
  worker: { type: "engine" },
  body: [],
};

let fileDir: string;

beforeEach(() => {
  // Binary steps spawn with this as their cwd, so it has to exist.
  fileDir = mkdtempSync(join(tmpdir(), "path-engine-run-parallel-test-"));
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
      identity: { runId: "run-1", rootRunId: "run-1", parentRunId: null, nodeId: null, nodeName: null },
      emit: async (o) => void observed.push(o),
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

describe("runNode — parallel", () => {
  const parallel = (secondBranchBody: Node[]): Node => ({
    type: "parallel",
    id: "fan", name: "fan",
    join: "collect",
    branches: [
      { id: "left", name: "left", body: [{ ...echo("l", "L"), publish: { from_left: "${output}" } } as Node] },
      { id: "right", name: "right", body: secondBranchBody },
    ],
  });

  it("keys its output by branch id in declaration order, whatever order they finish in", async () => {
    const { run, observed } = makeRun();
    const outcome = await runNode(run, parallel([echo("r", "R")]), "seed", makeExec());

    expect(outcome).toEqual({ status: "succeeded", output: { left: "L", right: "R" } });
    expect(observed.find((o) => o.type === "join-applied")).toMatchObject({
      nodeId: "fan", nodeName: "fan",
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
          id: "peek", name: "peek",
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
      parallel([{ type: "binary", id: "boom", name: "boom", command: "node", args: ["-e", "process.exit(3)"] }]),
      "seed",
      exec,
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/parallel "fan", branch "right"/);
    expect(exec.context).toEqual({});
  });

  /**
   * A node script that rendezvous with a sibling through a shared dir: write my flag, then poll for
   * the sibling's — succeeding only if both run concurrently. Run sequentially, the first would wait
   * out its deadline and exit non-zero. So a *success* is a genuine proof of concurrency (§5.2).
   */
  const rendezvous = (dir: string, me: string, other: string): Node => ({
    type: "binary",
    id: me,
    name: me,
    command: "node",
    args: [
      "-e",
      "const fs=require('fs'),dir=process.argv[1],me=process.argv[2],other=process.argv[3];fs.writeFileSync(dir+'/'+me,'1');const end=Date.now()+3000;(function p(){if(fs.existsSync(dir+'/'+other)){process.stdout.write(me);return;}if(Date.now()>end){process.exit(1);}setTimeout(p,10);})();",
      dir,
      me,
      other,
    ],
  });

  it("runs its branches concurrently, not one after another", async () => {
    const { run } = makeRun();
    const node: Node = {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        { id: "alpha", name: "alpha", body: [rendezvous(fileDir, "a", "b")] },
        { id: "beta", name: "beta", body: [rendezvous(fileDir, "b", "a")] },
      ],
    };

    expect(await runNode(run, node, "seed", makeExec())).toEqual({
      status: "succeeded",
      output: { alpha: "a", beta: "b" },
    });
  });

  it("gives each branch a snapshot of context at block entry — a sibling's publish is never visible", async () => {
    const { run } = makeRun();
    const node: Node = {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        { id: "writer", name: "writer", body: [{ ...echo("w", "w"), publish: { written: "${output}" } } as Node] },
        // Reads a key its sibling publishes; against the entry snapshot it does not exist, so this
        // branch fails — proving siblings never observe each other's writes (§5.3).
        { id: "reader", name: "reader", body: [{ ...echo("r", "r"), input: "${context.written}" } as Node] },
      ],
    };

    const outcome = await runNode(run, node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/written/);
  });

  it("kills an in-flight sibling when a branch fails, narrating it as sibling-failed", async () => {
    const { run, observed } = makeRun();
    const node: Node = {
      type: "parallel",
      id: "fan", name: "fan",
      join: "collect",
      branches: [
        // Sleeps well past the sibling's failure; it must be killed, not allowed to finish.
        {
          id: "slow", name: "slow",
          body: [
            {
              type: "binary",
              id: "sleeper", name: "sleeper",
              command: "node",
              args: ["-e", "setTimeout(()=>process.stdout.write('done'),5000)"],
              publish: { slow: "${output}" },
            },
          ],
        },
        { id: "boom", name: "boom", body: [{ type: "binary", id: "kaboom", name: "kaboom", command: "node", args: ["-e", "process.exit(1)"] }] },
      ],
    };

    const outcome = await runNode(run, node, "seed", makeExec());

    expect(outcome.status).toBe("failed");
    const started = observed.filter((o) => o.type === "step-started");
    const sleeper = started.find((o) => "nodeId" in o && o.nodeId === "sleeper")!;
    const kaboom = started.find((o) => "nodeId" in o && o.nodeId === "kaboom")!;

    // The failing branch's step run is the cause the sibling's cancellation points back at — an
    // operator cancel would carry `cause: "operator"` and a null cause run instead (#52).
    expect(observed.find((o) => o.type === "run-cancelled")).toMatchObject({
      runId: sleeper.runId,
      nodeId: "sleeper", nodeName: "sleeper",
      cause: "sibling-failed",
      causeRunId: kaboom.runId,
    });
    // No join, hence no publishes landed (§5.6).
    expect(observed.filter((o) => o.type === "join-applied")).toHaveLength(0);
  });

  it("holds concurrent processors to the semaphore's cap across the branches (§5.5)", async () => {
    let live = 0;
    let peakLive = 0;
    const worker: LlmWorker = {
      async runPrompt() {
        live += 1;
        peakLive = Math.max(peakLive, live);
        try {
          await new Promise((r) => setTimeout(r, 20));
          return { status: "succeeded", output: "ok", usage: null, estimatedCostUsd: null };
        } finally {
          live -= 1;
        }
      },
    };
    const { run } = makeRun({ llm: { worker, semaphore: createProcessorSemaphore(2) } });
    const ask = (id: string) => ({
      id,
      name: id,
      body: [{ type: "prompt" as const, id: `ask-${id}`, name: `ask-${id}`, prompt: "Hi.", worker: { type: "llm" as const, model: "m" } }],
    });
    const node: Node = { type: "parallel", id: "fan", name: "fan", join: "collect", branches: [ask("a"), ask("b"), ask("c"), ask("d")] };

    expect((await runNode(run, node, "seed", makeExec())).status).toBe("succeeded");
    expect(peakLive).toBe(2); // every branch ran, but never more than the cap at once
  });
});

describe("runNode — parallel wait-one", () => {
  // A binary that writes `text` after `ms`, publishing it under `answer` — the slow loser of a race.
  const sleepThenPublish = (id: string, ms: number, text: string): Node => ({
    type: "binary",
    id,
    name: id,
    command: "node",
    args: ["-e", `setTimeout(()=>process.stdout.write(${JSON.stringify(text)}),${ms})`],
    publish: { answer: "${output}" },
  });
  const failFast = (id: string): Node => ({ type: "binary", id, name: id, command: "node", args: ["-e", "process.exit(1)"] });

  it("keeps the first branch to succeed, landing only its publishes and naming it the winner", async () => {
    const { run, observed } = makeRun();
    const exec = makeExec();
    const node: Node = {
      type: "parallel",
      id: "race", name: "race",
      join: "wait-one",
      branches: [
        // The fast branch resolves at once; the slow one sleeps well past it and must be cancelled.
        { id: "fast", name: "fast", body: [{ ...echo("f", "FAST"), publish: { answer: "${output}" } } as Node] },
        { id: "slow", name: "slow", body: [sleepThenPublish("s", 5000, "SLOW")] },
      ],
    };

    const outcome = await runNode(run, node, "seed", exec);

    // Stable winner-keyed output (§3), and only the winner's buffered publish landed (§4).
    expect(outcome).toEqual({ status: "succeeded", output: { winner: { name: "fast", output: "FAST" } } });
    expect(exec.context).toEqual({ answer: "FAST" });
    expect(observed.find((o) => o.type === "join-applied")).toMatchObject({
      nodeId: "race", nodeName: "race",
      branches: ["fast"],
      publishedKeys: ["answer"],
      winner: "fast",
    });
    // The loser is cancelled best-effort with the new cause — nothing failed, so it is not sibling-failed.
    expect(observed.find((o) => o.type === "run-cancelled")).toMatchObject({
      nodeId: "s", nodeName: "s",
      cause: "sibling-succeeded",
      causeRunId: null,
    });
  });

  it("ignores a failing branch and lets a still-running branch win the race", async () => {
    const { run, observed } = makeRun();
    const exec = makeExec();
    const node: Node = {
      type: "parallel",
      id: "race", name: "race",
      join: "wait-one",
      branches: [
        // Fails immediately; under wait-one this cancels nothing and the race continues (§2).
        { id: "boom", name: "boom", body: [failFast("kab")] },
        // Succeeds only after a delay — proof the race outlived the failure rather than ending on it.
        { id: "winner", name: "winner", body: [sleepThenPublish("slowwin", 150, "W")] },
      ],
    };

    const outcome = await runNode(run, node, "seed", exec);

    expect(outcome).toEqual({ status: "succeeded", output: { winner: { name: "winner", output: "W" } } });
    expect(exec.context).toEqual({ answer: "W" });
    // The failure cancelled nothing — no sibling-failed anywhere.
    expect(observed.some((o) => o.type === "run-cancelled" && o.cause === "sibling-failed")).toBe(false);
  });

  it("fails the block with a synthetic aggregate when every branch fails", async () => {
    const { run, observed } = makeRun();
    const exec = makeExec();
    const node: Node = {
      type: "parallel",
      id: "race", name: "race",
      join: "wait-one",
      branches: [
        { id: "a", name: "a", body: [failFast("x")] },
        { id: "b", name: "b", body: [failFast("y")] },
      ],
    };

    const outcome = await runNode(run, node, "seed", exec);

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toMatch(/all 2 wait-one branches failed/);
    // No winner, so no join and no publishes (§2, §8).
    expect(observed.filter((o) => o.type === "join-applied")).toHaveLength(0);
    expect(exec.context).toEqual({});
  });

  it("treats a single-branch race as a degenerate one-runner win (branches.min(1))", async () => {
    const { run } = makeRun();
    const exec = makeExec();
    const node: Node = {
      type: "parallel",
      id: "race", name: "race",
      join: "wait-one",
      branches: [{ id: "only", name: "only", body: [{ ...echo("o", "O"), publish: { answer: "${output}" } } as Node] }],
    };

    const outcome = await runNode(run, node, "seed", exec);

    expect(outcome).toEqual({ status: "succeeded", output: { winner: { name: "only", output: "O" } } });
    expect(exec.context).toEqual({ answer: "O" });
  });
});
