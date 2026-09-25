import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue, WorkflowFile } from "@path/schema";
import { describe, expect, it } from "vitest";
import type { WorkerDescriptor } from "../src/plugin/seam.js";
import type { Observation } from "../src/run-observer.js";
import { runWorkflow, type RunOptions } from "../src/run-workflow.js";
import { fakeObserver } from "./fake-observer.js";
import { stampNames } from "./stamp-names.js";

/**
 * `goto` execution (docs/spec/goto.md §3–§6, §11 rows G-E-01 to G-E-11, G-E-19), driven through
 * `runWorkflow` and read back from the observations: the run tree is what `run-started` /
 * `step-started` record, so every assertion is about the tree a reader would see.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type Started = Extract<Observation, { type: "run-started" | "step-started" }>;

/**
 * A scripted `prompt` worker: each prompt text is a step, and its answer is `<prompt>-<visit>`, the
 * visit counted per prompt across the whole run. Every request's input is recorded per prompt.
 */
function scriptedPrompt(): { worker: WorkerDescriptor; inputs: Map<string, JsonValue[]> } {
  const inputs = new Map<string, JsonValue[]>();
  const worker: WorkerDescriptor = {
    meters: false,
    needsProcessorSlot: true,
    async run(request) {
      const prompt = String((request.fields as { prompt: string }).prompt);
      // `slow` holds its processor until the run is cancelled — the leaf a Cancel lands on.
      if (prompt === "slow") {
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
        return { status: "failed", error: "killed" };
      }
      const seen = inputs.get(prompt) ?? [];
      seen.push(request.input);
      inputs.set(prompt, seen);
      return { status: "succeeded", output: `${prompt}-${seen.length}` };
    },
  };
  return { worker, inputs };
}

function step(name: string, extra: { [key: string]: unknown } = {}) {
  return { type: "prompt", id: name, prompt: name, ...extra };
}

function file(body: unknown[], extra: { [key: string]: unknown } = {}): WorkflowFile {
  return stampNames({ format: "path/workflow@5", id: "wf-id", name: "jumps", config: { model: "claude-sonnet-5" }, body, ...extra } as unknown as WorkflowFile);
}

async function run(workflow: WorkflowFile, options: RunOptions = {}) {
  const observer = fakeObserver();
  const { worker, inputs } = scriptedPrompt();
  const result = await runWorkflow(workflow, fixturesDir, {
    observer,
    workerOverrides: { prompt: { anthropic: worker } },
    ...options,
  });
  const all = observer.all();
  const started = all.filter((o): o is Started => o.type === "run-started" || o.type === "step-started");
  const finished = (runId: string) =>
    all.find((o) => (o.type === "run-finished" || o.type === "step-finished") && o.runId === runId) as
      | Extract<Observation, { type: "run-finished" }>
      | undefined;
  const root = started.find((o) => o.parentRunId === null)!;
  const childrenOf = (runId: string) => started.filter((o) => o.parentRunId === runId);
  const passes = (parentRunId = root.runId) =>
    childrenOf(parentRunId).filter((o) => o.type === "run-started" && o.pass !== undefined) as Extract<
      Observation,
      { type: "run-started" }
    >[];
  return { result, all, started, inputs, root, childrenOf, passes, finished };
}

describe("goto — the top-level walk and its passes", () => {
  it("G-E-01: a goto-free file keeps today's tree, with no pass rows", async () => {
    const r = await run(file([step("a"), step("b")]));
    expect(r.result).toMatchObject({ status: "succeeded" });
    expect(r.passes()).toEqual([]);
    expect(r.childrenOf(r.root.runId).map((o) => o.nodeName)).toEqual(["a", "b"]);
  });

  it("G-E-04: a backward jump taken twice gives three passes, each B visit its own run and input", async () => {
    const r = await run(
      file([
        step("a"),
        step("b", { publish: { last: "${output}" } }),
        {
          type: "branch",
          id: "guard",
          arms: [{ when: { type: "one-of", path: "context.last", values: ["b-1", "b-2"] }, node: { type: "goto", id: "check", target: "b", max_jumps: 3 } }],
          else: step("done"),
        },
      ]),
    );
    expect(r.result).toMatchObject({ status: "succeeded" });

    const passes = r.passes();
    expect(passes.map((p) => [p.pass, p.nodeName])).toEqual([
      [1, null],
      [2, "check"],
      [3, "check"],
    ]);
    expect(passes.map((p) => r.finished(p.runId)?.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    // Every node run sits under a pass, never directly under the workflow-run.
    expect(r.childrenOf(r.root.runId).every((o) => o.type === "run-started" && o.pass !== undefined)).toBe(true);
    expect(passes.map((p) => r.childrenOf(p.runId).map((o) => o.nodeName))).toEqual([["a", "b"], ["b"], ["b", "done"]]);
    // Each B visit reads the goto's passed-through output: the guard's incoming output, B's own last output.
    expect(r.inputs.get("b")).toEqual(["a-1", "b-1", "b-2"]);
    // Pass N's input is its seed: the workflow input for pass 1, the goto's passed-through output after.
    expect(passes.map((p) => p.input)).toEqual([{}, "b-1", "b-2"]);
  });

  it("G-E-02: a guarded goto whose condition is never true gives pass 1 only, succeeded", async () => {
    const r = await run(
      file([
        step("a", { publish: { last: "${output}" } }),
        guardedGoto("guard", ["never"], { id: "check", target: "a", max_jumps: 3 }),
      ]),
    );
    expect(r.result).toMatchObject({ status: "succeeded" });
    expect(r.passes().map((p) => [p.pass, p.nodeName, r.finished(p.runId)?.status])).toEqual([[1, null, "succeeded"]]);
  });

  it("G-E-03: a forward jump skips B, and C reads the goto's passed-through output", async () => {
    const r = await run(file([step("a"), { type: "goto", id: "check", target: "c", max_jumps: 1 }, step("b"), step("c")]));
    expect(r.result).toMatchObject({ status: "succeeded" });
    const passes = r.passes();
    expect(passes.map((p) => [p.pass, p.nodeName])).toEqual([
      [1, null],
      [2, "check"],
    ]);
    expect(passes.map((p) => r.childrenOf(p.runId).map((o) => o.nodeName))).toEqual([["a"], ["c"]]);
    expect(r.started.some((o) => o.nodeName === "b")).toBe(false);
    expect(r.inputs.get("c")).toEqual(["a-1"]);
  });

  it("G-E-05: a condition that stays true fails pass 3 and the workflow-run once max_jumps (2) is spent", async () => {
    const r = await run(
      file([
        step("a"),
        step("b", { publish: { last: "${output}" } }),
        { type: "branch", id: "guard", arms: [{ when: { type: "exists", path: "context.last" }, node: { type: "goto", id: "check", target: "b", max_jumps: 2 } }] },
      ]),
    );
    const message = 'goto "check": max_jumps (2) exhausted';
    expect(r.result).toMatchObject({ status: "failed", error: message });
    expect(r.passes().map((p) => [p.pass, r.finished(p.runId)])).toEqual([
      [1, expect.objectContaining({ status: "succeeded" })],
      [2, expect.objectContaining({ status: "succeeded" })],
      [3, expect.objectContaining({ status: "failed", error: message })],
    ]);
    expect(r.finished(r.root.runId)).toMatchObject({ status: "failed", error: message });
  });

  it("G-E-07 / 08: a goto in a nested workflow-ref file has its own passes, and each fresh child run counts from zero", async () => {
    // The child jumps once per run (`max_jumps: 1`), on its first `x` visit. Run twice by the parent's
    // own loop, its second run would exhaust if the count carried over from the first.
    const child = file(
      [step("x", { publish: { last: "${output}" } }), guardedGoto("child-guard", ["x-1", "x-3"], { id: "again", target: "x", max_jumps: 1 })],
      { id: "child-id", name: "child", output: { last: "${context.last}" } },
    );
    const parent = file([
      { type: "workflow", id: "w", ref: "child.workflow.json", publish: { out: "${output.last}" } },
      guardedGoto("parent-guard", ["x-2"], { id: "redo", target: "w", max_jumps: 1 }, "context.out"),
    ]);
    const r = await run(parent, { files: new Map([[resolve(fixturesDir, "child.workflow.json"), child]]) });
    expect(r.result).toMatchObject({ status: "succeeded" });

    const parentPasses = r.passes();
    expect(parentPasses.map((p) => [p.pass, p.nodeName])).toEqual([
      [1, null],
      [2, "redo"],
    ]);
    // The parent sees one ordinary `workflow` step run per pass; each child run holds its own passes.
    const childRuns = parentPasses.map((p) => r.childrenOf(p.runId));
    expect(childRuns.map((runs) => runs.map((o) => o.nodeName))).toEqual([["w"], ["w", "parent-guard-else"]]);
    for (const [childRun] of childRuns) {
      expect(r.passes(childRun!.runId).map((p) => [p.pass, p.nodeName])).toEqual([
        [1, null],
        [2, "again"],
      ]);
    }
    expect(r.inputs.get("x")).toHaveLength(4);
  });

  describe("G-E-09: a target reading a context key published after it", () => {
    const loop = () =>
      file([
        step("t", { input: { v: "${context.verdict}" } }),
        step("judge", { publish: { verdict: "${output}" } }),
        guardedGoto("guard", ["judge-1"], { id: "retry", target: "t", max_jumps: 3 }, "context.verdict"),
      ]);

    it("reads pass 1's value in pass 2 when seeded", async () => {
      const r = await run(loop(), { input: { verdict: "seed" } });
      expect(r.result).toMatchObject({ status: "succeeded" });
      expect(r.inputs.get("t")).toEqual([{ v: "seed" }, { v: "judge-1" }]);
    });

    it("fails pass 1 with the InterpolationError when unseeded", async () => {
      const r = await run(loop());
      expect(r.result).toMatchObject({ status: "failed", error: expect.stringMatching(/^node "t": .*verdict/) });
      const [pass1] = r.passes();
      expect(r.finished(pass1!.runId)).toMatchObject({ status: "failed" });
    });
  });

  it("G-E-10: a first-level wait-one parallel as jump target joins on each visit", async () => {
    const r = await run(
      file([
        {
          type: "parallel",
          id: "race",
          join: "wait-one",
          branches: [step("p", { publish: { answer: "${output}" } }), step("q", { publish: { answer: "${output}" } })],
        },
        guardedGoto("guard", ["p-1", "q-1"], { id: "rerace", target: "race", max_jumps: 1 }, "context.answer"),
      ]),
    );
    expect(r.result).toMatchObject({ status: "succeeded" });
    expect(r.passes()).toHaveLength(2);
    expect(r.all.filter((o) => o.type === "join-applied")).toHaveLength(2);
  });

  it("G-E-11: an interpolated max_jumps resolves against config and bounds the loop", async () => {
    const r = await run(
      file(
        [
          step("b", { publish: { last: "${output}" } }),
          { type: "branch", id: "guard", arms: [{ when: { type: "exists", path: "context.last" }, node: { type: "goto", id: "check", target: "b", max_jumps: "${config.n}" } }] },
        ],
        { config: { model: "claude-sonnet-5", n: 2 } },
      ),
    );
    expect(r.result).toMatchObject({ status: "failed", error: 'goto "check": max_jumps (2) exhausted' });
    expect(r.passes()).toHaveLength(3);
  });

  it("G-E-19: Cancel while a pass holds a running leaf ends the pass and the workflow-run cancelled", async () => {
    const controller = new AbortController();
    const running = run(
      file([step("a", { publish: { last: "${output}" } }), step("slow"), guardedGoto("guard", ["a-1"], { id: "check", target: "a", max_jumps: 3 })]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const r = await running;
    expect(r.result).toMatchObject({ status: "cancelled" });
    const [pass1, ...rest] = r.passes();
    expect(rest).toEqual([]);
    expect(r.finished(pass1!.runId)).toMatchObject({ status: "cancelled" });
    expect(r.finished(r.root.runId)).toMatchObject({ status: "cancelled" });
  });
});

describe("goto — audit events (spec §7, ADR 0061)", () => {
  type GotoEvent = Extract<Observation, { type: "pass-started" | "goto-taken" | "goto-exhausted" }>;
  const gotoEvents = (all: Observation[]) =>
    all.filter((o): o is GotoEvent => o.type === "pass-started" || o.type === "goto-taken" || o.type === "goto-exhausted");

  /**
   * The observations in arrival order — the order the logging observer stamps `seq` in — as short
   * labels, with pass runs named `pass N` and node runs by their node name.
   */
  function narrative(r: Awaited<ReturnType<typeof run>>): string[] {
    const passOf = new Map(r.passes().map((p) => [p.runId, p.pass!]));
    const who = (runId: string, nodeName: string | null) =>
      passOf.has(runId) ? `pass ${passOf.get(runId)}` : runId === r.root.runId ? "workflow" : nodeName;
    return r.all.flatMap((o) => {
      switch (o.type) {
        case "run-started":
        case "step-started":
          return o.parentRunId === null ? [] : [`started ${who(o.runId, o.nodeName)}`];
        case "run-finished":
        case "step-finished":
          return [`finished ${who(o.runId, o.nodeName)} ${o.status}`];
        case "pass-started":
          return [`pass-started ${o.pass}`];
        case "goto-taken":
          return [`goto-taken ${o.nodeName}→${o.targetNodeName} ${o.jump}/${o.maxJumps} pass ${o.pass}`];
        case "goto-exhausted":
          return [`goto-exhausted ${o.nodeName}→${o.targetNodeName} ${o.maxJumps} pass ${o.pass}`];
        default:
          return [];
      }
    });
  }

  const backwardLoop = (maxJumps: number | string, values = ["b-1", "b-2"]) => [
    step("a"),
    step("b", { publish: { last: "${output}" } }),
    guardedGoto("guard", values, { id: "check", target: "b", max_jumps: maxJumps }),
  ];

  it("G-E-01: a goto-free file emits no goto event", async () => {
    const r = await run(file([step("a"), step("b")]));
    expect(gotoEvents(r.all)).toEqual([]);
  });

  it("G-E-02: a guarded goto never taken gives one pass-started and no goto-taken", async () => {
    const r = await run(file(backwardLoop(3, ["never"])));
    expect(gotoEvents(r.all)).toEqual([
      { type: "pass-started", runId: r.root.runId, rootRunId: r.root.rootRunId, nodeId: null, nodeName: null, pass: 1 },
    ]);
  });

  it("G-E-03: a forward jump's goto-taken names the target, jump 1 and the pass it opens", async () => {
    const r = await run(file([step("a"), { type: "goto", id: "check", target: "c", max_jumps: 1 }, step("b"), step("c")]));
    const taken = gotoEvents(r.all).filter((o) => o.type === "goto-taken");
    expect(taken).toEqual([
      {
        type: "goto-taken",
        runId: r.root.runId,
        rootRunId: r.root.rootRunId,
        nodeId: "check",
        nodeName: "check",
        targetNodeId: "c",
        targetNodeName: "c",
        jump: 1,
        maxJumps: 1,
        pass: 2,
      },
    ]);
  });

  it("G-E-04 / G-E-06: a backward loop narrates each jump in the §7 order", async () => {
    const r = await run(file(backwardLoop(3)));
    expect(r.result).toMatchObject({ status: "succeeded" });
    // Every goto event is attributed to the workflow-run, never a pass container.
    expect(gotoEvents(r.all).every((o) => o.runId === r.root.runId)).toBe(true);
    expect(gotoEvents(r.all).filter((o) => o.type === "pass-started").map((o) => [o.pass, o.nodeName])).toEqual([
      [1, null],
      [2, "check"],
      [3, "check"],
    ]);
    expect(narrative(r)).toEqual([
      "started pass 1",
      "pass-started 1",
      "started a",
      "finished a succeeded",
      "started b",
      "finished b succeeded",
      "goto-taken check→b 1/3 pass 2",
      "finished pass 1 succeeded",
      "started pass 2",
      "pass-started 2",
      "started b",
      "finished b succeeded",
      "goto-taken check→b 2/3 pass 3",
      "finished pass 2 succeeded",
      "started pass 3",
      "pass-started 3",
      "started b",
      "finished b succeeded",
      "started guard-else",
      "finished guard-else succeeded",
      "finished pass 3 succeeded",
      "finished workflow succeeded",
    ]);
  });

  it("G-E-05 / G-E-06: an exhausted loop gives 2 goto-taken, then goto-exhausted before the failures", async () => {
    const r = await run(
      file([
        step("a"),
        step("b", { publish: { last: "${output}" } }),
        { type: "branch", id: "guard", arms: [{ when: { type: "exists", path: "context.last" }, node: { type: "goto", id: "check", target: "b", max_jumps: 2 } }] },
      ]),
    );
    const events = gotoEvents(r.all).filter((o) => o.type !== "pass-started");
    expect(events.map((o) => o.type)).toEqual(["goto-taken", "goto-taken", "goto-exhausted"]);
    expect(events[2]).toEqual({
      type: "goto-exhausted",
      runId: r.root.runId,
      rootRunId: r.root.rootRunId,
      nodeId: "check",
      nodeName: "check",
      targetNodeId: "b",
      targetNodeName: "b",
      maxJumps: 2,
      pass: 3,
    });
    expect(narrative(r).slice(-4)).toEqual([
      "finished b succeeded",
      "goto-exhausted check→b 2 pass 3",
      "finished pass 3 failed",
      "finished workflow failed",
    ]);
  });

  it("G-E-11: goto-taken carries the resolved max_jumps of an interpolated bound", async () => {
    const r = await run(file(backwardLoop("${config.n}"), { config: { model: "claude-sonnet-5", n: 4 } }));
    const taken = gotoEvents(r.all).filter((o) => o.type === "goto-taken");
    expect(taken.map((o) => [o.jump, o.maxJumps, o.pass])).toEqual([
      [1, 4, 2],
      [2, 4, 3],
    ]);
  });

  it("G-E-19: a Cancel emits no goto event beyond pass 1's pass-started", async () => {
    const controller = new AbortController();
    const running = run(
      file([step("a", { publish: { last: "${output}" } }), step("slow"), guardedGoto("guard", ["a-1"], { id: "check", target: "a", max_jumps: 3 })]),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const r = await running;
    expect(r.result).toMatchObject({ status: "cancelled" });
    expect(gotoEvents(r.all).map((o) => o.type)).toEqual(["pass-started"]);
  });
});

/** A first-level `branch` whose one arm holds a goto, taken when `path` is one of `values`; else a plain step. */
function guardedGoto(id: string, values: string[], goto: { id: string; target: string; max_jumps: number | string }, path = "context.last") {
  return { type: "branch", id, arms: [{ when: { type: "one-of", path, values }, node: { type: "goto", ...goto } }], else: step(`${id}-else`) };
}
