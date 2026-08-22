import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, RunRecord, WorkflowFile } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmWorker } from "../src/llm/llm-worker.js";
import type { Observation } from "../src/run-observer.js";
import { writeRunBlob } from "../src/persistence/blob-store.js";
import { openDb } from "../src/persistence/db.js";
import { RUN_BLOB_FILE, runBlobDir } from "../src/persistence/paths.js";
import { createPersistedObserver } from "../src/persistence/persisted-observer.js";
import { getRunsForRoot } from "../src/persistence/run-store.js";
import { fakeObserver, type FakeObserver } from "./fake-observer.js";
import { runWorkflow, type ResumeInput } from "../src/run-workflow.js";
import { stampNames } from "./stamp-names.js";

/**
 * Engine consumption of the reuse plan (#172): a resumed run reuses a succeeded node's recorded
 * `output.json` instead of re-executing it, restores each re-entered workflow-run's `context.json`
 * from the original tree, and narrates every reuse decision with a single `reuse-marker` — while
 * never opening the original tree for writing. The plan itself is #170's pure `planReuse`; this
 * suite drives what the walker does with it.
 */

// A run row of the original tree, with the fields planReuse and the restore path read.
function run(overrides: Partial<RunRecord> & Pick<RunRecord, "runId" | "parentRunId" | "nodeId" | "status">): RunRecord {
  return {
    rootRunId: "orig-root",
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
    reusedFromRootRunId: null,
    workflowId: null,
    workflowName: null,
    workflowPath: null,
    ...overrides,
  };
}

/** An llm worker that records which nodes actually executed and answers a per-node canned output. */
function recordingWorker(outputs: { [nodeName: string]: string }, ran: string[]): LlmWorker {
  return {
    runPrompt: async (request) => {
      ran.push(request.nodeName);
      return {
        status: "succeeded",
        output: outputs[request.nodeName] ?? `ran-${request.nodeName}`,
        usage: null,
        estimatedCostUsd: null,
      };
    },
  };
}

/** A reader over an in-memory original tree, recording every `<runId>/<filename>` it is asked for. */
function reader(blobs: { [key: string]: JsonValue }, reads: string[]): ResumeInput["readBlob"] {
  return (record, filename) => {
    const key = `${record.runId}/${filename}`;
    reads.push(key);
    if (!(key in blobs)) throw new Error(`no such original blob: ${key}`);
    return blobs[key]!;
  };
}

function tree(body: WorkflowFile["body"], output?: WorkflowFile["output"]): WorkflowFile {
  // stampNames keeps each node's human id in place (so resume matching by id still works) and mirrors
  // it to `name`; runWorkflow takes the object directly, so no UUIDs are needed here.
  return stampNames({ format: "path/workflow@2", name: "resumed", worker: { type: "llm", model: "m" }, body, ...(output ? { output } : {}) });
}

function markers(observer: FakeObserver): Extract<Observation, { type: "reuse-marker" }>[] {
  return observer.all().filter((o): o is Extract<Observation, { type: "reuse-marker" }> => o.type === "reuse-marker");
}

function startedNodeIds(observer: FakeObserver): (string | null)[] {
  return observer
    .all()
    .filter((o): o is Extract<Observation, { type: "step-started" }> => o.type === "step-started")
    .map((o) => o.nodeId);
}

describe("resume — reusing a node's recorded output (#172)", () => {
  it("reuses a succeeded node (marker, no execution, no step-started) and runs a non-reused one ordinarily", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const file = tree(
      [
        { type: "prompt", id: "a", name: "a", prompt: "hi", publish: { fromA: "${output}" } },
        { type: "prompt", id: "b", name: "b", prompt: "yo", publish: { fromB: "${output}" } },
      ],
      { a: "${context.fromA}", b: "${context.fromB}" },
    );

    const result = await runWorkflow(file, "/tmp", {
      observer,
      llmWorker: recordingWorker({ b: "FRESH_B" }, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
          run({ runId: "b-run", parentRunId: "orig-root", nodeId: "b", nodeName: "b", status: "failed" }),
        ],
        readBlob: reader({ "orig-root/context.json": {}, "a-run/output.json": "REUSED_A" }, reads),
      },
    });

    // a reused, b executed
    expect(ran).toEqual(["b"]);
    expect(result.status).toBe("succeeded");
    // The reused output flows the default-input chain and the workflow output exactly like a fresh one.
    expect(result.output).toEqual({ a: "REUSED_A", b: "FRESH_B" });

    // Exactly one reuse-marker, for a, pointing at the original run; run_id is this successor's root run.
    const m = markers(observer);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ nodeId: "a", nodeName: "a", originalRunId: "a-run" });

    // No step-started/step-finished for the reused node; the executed one has both.
    expect(startedNodeIds(observer)).toEqual(["b"]);
    expect(observer.all().some((o) => o.type === "step-finished")).toBe(true);
  });

  it("threads a reused output into the next node's default input just like a produced one", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const inputs: JsonValue[] = [];
    const worker: LlmWorker = {
      runPrompt: async (request) => {
        ran.push(request.nodeName);
        inputs.push(request.input);
        return { status: "succeeded", output: "FRESH_B", usage: null, estimatedCostUsd: null };
      },
    };
    const file = tree([
      { type: "prompt", id: "a", name: "a", prompt: "hi" },
      { type: "prompt", id: "b", name: "b", prompt: "yo" },
    ]);

    await runWorkflow(file, "/tmp", {
      llmWorker: worker,
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
        ],
        readBlob: reader({ "orig-root/context.json": {}, "a-run/output.json": "REUSED_A" }, reads),
      },
    });

    expect(ran).toEqual(["b"]);
    expect(inputs).toEqual(["REUSED_A"]); // b's default input is a's reused output
  });

  it("collapses a reused workflow-run's whole subtree — one marker, nothing inside walked", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const nestedPath = join("/tmp", "nested.workflow.json");
    const nested = tree([{ type: "prompt", id: "inner", name: "inner", prompt: "deep" }], { r: "${output}" });
    const file = tree([{ type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json" }]);

    const result = await runWorkflow(file, "/tmp", {
      observer,
      files: new Map([[nestedPath, nested]]),
      llmWorker: recordingWorker({}, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", nodeName: "sub", status: "succeeded" }),
          // A descendant inside the collapsed subtree: it must never be walked, so its blob is never read.
          run({ runId: "inner-run", parentRunId: "sub-run", nodeId: "inner", nodeName: "inner", status: "succeeded" }),
        ],
        readBlob: reader({ "orig-root/context.json": {}, "sub-run/output.json": { r: "SUB" } }, reads),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual([]); // nothing inside the collapsed subtree executed
    // One marker for the reuse decision, not one per descendant.
    const m = markers(observer);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ nodeId: "sub", nodeName: "sub", originalRunId: "sub-run" });
    // The descendant's blob was never touched — the subtree was never walked.
    expect(reads.some((key) => key.startsWith("inner-run/"))).toBe(false);
  });

  it("restores context and reuses inside a re-entered nested workflow-run, not just the root", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const nestedPath = join("/tmp", "nested.workflow.json");
    const nested = tree([
      { type: "prompt", id: "x", name: "x", prompt: "hi", publish: { fromX: "${output}" } },
      { type: "prompt", id: "y", name: "y", prompt: "yo" },
    ]);
    const file = tree([{ type: "workflow", id: "sub", name: "sub", ref: "./nested.workflow.json" }]);

    const result = await runWorkflow(file, "/tmp", {
      observer,
      files: new Map([[nestedPath, nested]]),
      llmWorker: recordingWorker({ y: "FRESH_Y" }, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          // sub failed originally, so it re-enters rather than reusing — its succeeded child x reuses.
          run({ runId: "sub-run", parentRunId: "orig-root", nodeId: "sub", nodeName: "sub", status: "failed" }),
          run({ runId: "x-run", parentRunId: "sub-run", nodeId: "x", nodeName: "x", status: "succeeded" }),
          run({ runId: "y-run", parentRunId: "sub-run", nodeId: "y", nodeName: "y", status: "failed" }),
        ],
        readBlob: reader(
          {
            "orig-root/context.json": {},
            "sub-run/context.json": { restored: "CTX" },
            "x-run/output.json": "REUSED_X",
          },
          reads,
        ),
      },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual(["y"]); // x reused inside the nested run; only y ran fresh

    // The nested run re-entered: there is a run-started for the `sub` node with a fresh run id.
    const subStarted = observer
      .all()
      .find((o): o is Extract<Observation, { type: "run-started" }> => o.type === "run-started" && o.nodeId === "sub");
    expect(subStarted).toBeDefined();

    // x's reuse-marker is attributed to the nested run, not the root — the nearest re-entered ancestor.
    const m = markers(observer);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ nodeId: "x", nodeName: "x", originalRunId: "x-run", runId: subStarted!.runId });

    // The nested run's restored context was read from the original tree (restore-by-load) and lands
    // in the new tree. `restored` exists only in the original `context.json` — never in the workflow
    // input or any publish — so its presence in the new tree's nested context proves the restore,
    // and `fromX` proves the reused node still published into that restored blackboard.
    expect(reads).toContain("sub-run/context.json");
    const nestedContexts = observer
      .all()
      .filter((o): o is Extract<Observation, { type: "context-changed" }> => o.type === "context-changed" && o.runId === subStarted!.runId)
      .map((o) => o.context);
    expect(nestedContexts.length).toBeGreaterThan(0);
    expect(nestedContexts.at(-1)).toEqual({ restored: "CTX", fromX: "REUSED_X" });
  });

  it("re-runs a from-scratch tree normally when there is nothing to resume from", async () => {
    const ran: string[] = [];
    const observer = fakeObserver();
    const file = tree([{ type: "prompt", id: "a", name: "a", prompt: "hi" }]);

    const result = await runWorkflow(file, "/tmp", {
      observer,
      llmWorker: recordingWorker({ a: "FRESH" }, ran),
      resume: { originalRuns: [], readBlob: reader({}, []) },
    });

    expect(result.status).toBe("succeeded");
    expect(ran).toEqual(["a"]); // no original root run → empty plan → everything runs
    expect(markers(observer)).toHaveLength(0);
  });
});

describe("resume — the original tree is read-only (#172)", () => {
  let origDir: string;
  let newDir: string;
  let newDb: Database.Database;

  beforeEach(() => {
    origDir = mkdtempSync(join(tmpdir(), "path-engine-resume-orig-"));
    newDir = mkdtempSync(join(tmpdir(), "path-engine-resume-new-"));
    newDb = openDb(join(newDir, ".path", "path.db"));
  });

  afterEach(() => {
    newDb.close();
    rmSync(origDir, { recursive: true, force: true });
    rmSync(newDir, { recursive: true, force: true });
  });

  it("writes only under the new tree, never opening the original tree's blobs or rows for writing", async () => {
    // A real original tree on disk: a succeeded node's output, and the root's context.
    writeRunBlob(origDir, "orig-root", "a-run", RUN_BLOB_FILE.output, "REUSED_A");
    writeRunBlob(origDir, "orig-root", "orig-root", RUN_BLOB_FILE.context, {});
    const before = snapshot(origDir);

    const observer = createPersistedObserver(newDb, newDir);
    const ran: string[] = [];
    const file = tree(
      [
        { type: "prompt", id: "a", name: "a", prompt: "hi", publish: { fromA: "${output}" } },
        { type: "prompt", id: "b", name: "b", prompt: "yo", publish: { fromB: "${output}" } },
      ],
      { out: "${context.fromA}" },
    );

    const result = await runWorkflow(file, newDir, {
      observer,
      llmWorker: recordingWorker({ b: "FRESH_B" }, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "a-run", parentRunId: "orig-root", nodeId: "a", nodeName: "a", status: "succeeded" }),
        ],
        readBlob: (record, filename) => JSON.parse(readFileSync(join(runBlobDir(origDir, record.rootRunId, record.runId), filename), "utf8")) as JsonValue,
      },
    });

    expect(result.status).toBe("succeeded");
    // The original tree is byte-for-byte unchanged — no row and no blob was opened for writing.
    expect(snapshot(origDir)).toEqual(before);

    // The successor got its own tree under the new project dir, keyed on a fresh root run id.
    const newRootId = (newDb.prepare("SELECT root_run_id FROM runs WHERE run_id = root_run_id LIMIT 1").get() as { root_run_id: string } | undefined)?.root_run_id;
    expect(newRootId).toBeDefined();
    expect(newRootId).not.toBe("orig-root");
    expect(getRunsForRoot(newDb, newRootId!).length).toBeGreaterThan(0);
  });
});

describe("resume — wait-one join re-evaluates and short-circuits the losers (§7)", () => {
  // The original tree decided the race: the winner branch's step succeeded (reusable), the loser was
  // cancelled (not `succeeded`, so absent from the plan). Replaying must reuse the winner and start
  // no loser at all — no run for cause-blindness to re-run, so no re-fired side effects.
  const raceFile = tree(
    [
      {
        type: "parallel",
        id: "race", name: "race",
        join: "wait-one",
        branches: [
          { type: "sequence", id: "fast", name: "fast", body: [{ type: "prompt", id: "f", name: "f", prompt: "hi", publish: { answer: "${output}" } }] },
          { type: "sequence", id: "slow", name: "slow", body: [{ type: "prompt", id: "s", name: "s", prompt: "yo", publish: { answer: "${output}" } }] },
        ],
      },
    ],
    { answer: "${context.answer}" },
  );

  it("reuses the recorded winner and never starts the cancelled loser", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(raceFile, "/tmp", {
      observer,
      llmWorker: recordingWorker({}, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "f-run", parentRunId: "orig-root", nodeId: "f", nodeName: "f", status: "succeeded" }),
          run({ runId: "s-run", parentRunId: "orig-root", nodeId: "s", nodeName: "s", status: "cancelled" }),
        ],
        // Only the winner's blob exists; a read of the loser's would throw, proving it is never reused.
        readBlob: reader({ "orig-root/context.json": {}, "f-run/output.json": "REUSED_F" }, reads),
      },
    });

    // Nothing executed on the worker — the winner reused — and the loser was never launched.
    expect(ran).toEqual([]);
    expect(result.status).toBe("succeeded");
    // Only the winner's publish landed, exactly as a fresh win would.
    expect(result.output).toEqual({ answer: "REUSED_F" });

    // The winner reused (one marker), the loser did not reuse and was not started.
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["f"]);
    expect(startedNodeIds(observer)).not.toContain("s");
    expect(reads).not.toContain("s-run/output.json");

    // The join re-evaluated to a win naming the reused winner; no loser run means no run-cancelled.
    expect(observer.all().find((o) => o.type === "join-applied")).toMatchObject({ nodeId: "race", nodeName: "race", winner: "fast" });
    expect(observer.all().some((o) => o.type === "run-cancelled")).toBe(false);
  });

  it("reproduces the seq-first winner when a photo-finish left two branches succeeded, not declaration order", async () => {
    // Best-effort cancellation is async, so a race can record *two* succeeded branches. The original
    // run named the branch that finished first (lower seq, §6). Here that is the second-declared
    // branch, so a declaration-order pick would crown the wrong one; resume must follow completion time.
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();
    const file = tree(
      [
        {
          type: "parallel",
          id: "race", name: "race",
          join: "wait-one",
          branches: [
            // Declared first, but finished *later* (t2) — the loser of the photo-finish.
            { type: "sequence", id: "late", name: "late", body: [{ type: "prompt", id: "l", name: "l", prompt: "hi", publish: { answer: "${output}" } }] },
            // Declared second, finished *first* (t1) — the recorded winner.
            { type: "sequence", id: "early", name: "early", body: [{ type: "prompt", id: "e", name: "e", prompt: "yo", publish: { answer: "${output}" } }] },
          ],
        },
      ],
      { answer: "${context.answer}" },
    );

    const result = await runWorkflow(file, "/tmp", {
      observer,
      llmWorker: recordingWorker({}, ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "l-run", parentRunId: "orig-root", nodeId: "l", nodeName: "l", status: "succeeded", finishedAt: "2026-08-09T00:00:02.000Z" }),
          run({ runId: "e-run", parentRunId: "orig-root", nodeId: "e", nodeName: "e", status: "succeeded", finishedAt: "2026-08-09T00:00:01.000Z" }),
        ],
        readBlob: reader(
          { "orig-root/context.json": {}, "e-run/output.json": "EARLY", "l-run/output.json": "LATE" },
          reads,
        ),
      },
    });

    expect(ran).toEqual([]);
    expect(result.status).toBe("succeeded");
    // The earlier-finishing (second-declared) branch is the winner, not the first-declared one.
    expect(result.output).toEqual({ answer: "EARLY" });
    expect(markers(observer).map((m) => m.nodeId)).toEqual(["e"]);
    expect(observer.all().find((o) => o.type === "join-applied")).toMatchObject({ winner: "early" });
    // The losing-but-succeeded branch was neither started nor reused.
    expect(startedNodeIds(observer)).not.toContain("l");
    expect(reads).not.toContain("l-run/output.json");
  });
});

describe("resume — do-not-wait re-fires a non-`succeeded` detached branch; no short-circuit (ADR 0009)", () => {
  // In contrast to the wait-one suite above — which re-evaluates the race and short-circuits the
  // cancelled loser so it never starts — do-not-wait has no race and no winner. A detached branch left
  // non-`succeeded` in the predecessor is ordinary *unfinished* work, so cause-blind resume RE-RUNS it
  // (ADR 0009): do-not-wait adds nothing to the resume contract. This locks the *absence* of a
  // short-circuit so no future change quietly introduces one.
  //
  // The predecessor's detached branch is `failed` (issue #215 headline; the #214 blocked-by exists
  // precisely so this failed-branch re-run is exercisable). On resume it re-runs and fails *again*, and
  // failure isolation (ADR 0008 / #214) keeps the resumed run `succeeded` — the same at-least-once
  // re-fire every non-`succeeded` node gets, with no carve-out for the detached branch.
  const file = tree(
    [
      // A succeeded predecessor node, reused on resume — proves the reuse machinery is live, so the
      // detached branch's re-run below is a deliberate non-reuse, not resume failing to reuse anything.
      { type: "prompt", id: "pre", name: "pre", prompt: "hi", publish: { seed: "${output}" } },
      {
        type: "parallel",
        id: "fire", name: "fire",
        join: "do-not-wait",
        branches: [
          { type: "sequence", id: "detached", name: "detached", body: [{ type: "prompt", id: "d", name: "d", prompt: "notify" }] },
        ],
      },
    ],
    { seed: "${context.seed}" },
  );

  // A worker that reports every `d` re-run as `failed` (records the call), so the re-executed detached
  // branch fails exactly as it did in the predecessor. `pre` is reused and never reaches the worker.
  const failingBranchWorker = (ran: string[]): LlmWorker => ({
    runPrompt: async (request) => {
      ran.push(request.nodeName);
      return { status: "failed", error: "detached branch failed again on re-run", usage: null, estimatedCostUsd: null };
    },
  });

  it("re-runs the failed detached branch fresh, never reusing it and never short-circuiting it", async () => {
    const ran: string[] = [];
    const reads: string[] = [];
    const observer = fakeObserver();

    const result = await runWorkflow(file, "/tmp", {
      observer,
      llmWorker: failingBranchWorker(ran),
      resume: {
        originalRuns: [
          run({ runId: "orig-root", parentRunId: null, nodeId: null, nodeName: null, status: "failed" }),
          run({ runId: "pre-run", parentRunId: "orig-root", nodeId: "pre", nodeName: "pre", status: "succeeded" }),
          run({ runId: "d-run", parentRunId: "orig-root", nodeId: "d", nodeName: "d", status: "failed" }),
        ],
        // The detached branch's blob is deliberately absent: any attempt to *reuse* it would throw,
        // catching a short-circuit that tried to restore it instead of re-running.
        readBlob: reader({ "orig-root/context.json": {}, "pre-run/output.json": "REUSED_PRE" }, reads),
      },
    });

    // Failure isolation holds on resume: the re-run's failure did not fail the run (ADR 0008 / #214).
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ seed: "REUSED_PRE" }); // the reused predecessor still published.

    // `pre` succeeded → reused (one marker, no execution). The failed detached branch → re-ran on the
    // worker. So exactly the detached branch executed, and only the predecessor reused.
    const markerIds = markers(observer).map((m) => m.nodeId);
    expect(ran).toEqual(["d"]);
    expect(markerIds).toEqual(["pre"]);

    // The lock. The detached branch produced a FRESH step-started *and* step-finished — it was neither
    // reused (no marker for `d`) nor short-circuited away (a wait-one loser never starts; this one does).
    expect(startedNodeIds(observer)).toContain("d");
    expect(markerIds).not.toContain("d");
    const dRunId = observer.all().find((o) => o.type === "step-started" && o.nodeName === "d")!.runId;
    expect(observer.all().find((o) => o.type === "step-finished" && o.runId === dRunId)).toMatchObject({ status: "failed" });
    // Its recorded output was never read: resume re-executed it rather than restoring it.
    expect(reads).not.toContain("d-run/output.json");

    // No wait-one machinery: the join fires (spec §9) but crowns no winner, and nothing was cancelled —
    // there is no reused winner making the branch pointless, so nothing to short-circuit.
    const joinApplied = observer.all().find((o) => o.type === "join-applied" && o.nodeName === "fire");
    expect(joinApplied).toBeDefined();
    expect(joinApplied).not.toHaveProperty("winner");
    expect(observer.all().some((o) => o.type === "run-cancelled")).toBe(false);
  });
});

// A recursive content snapshot of a directory: relative path → bytes, for an unchanged-check.
function snapshot(dir: string): { [rel: string]: string } {
  const out: { [rel: string]: string } = {};
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d)) {
      const abs = join(d, entry);
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, childRel);
      else out[childRel] = readFileSync(abs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
