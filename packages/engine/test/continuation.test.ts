import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchFacts, RunRecord } from "@path/schema";
import { continuationBlobReader, continuationOf, continuationRunOptions, sourceRuns, successorCapture } from "../src/continuation.js";
import type { ContinueState, RunContext } from "../src/run-context.js";
import type { Observation } from "../src/run-observer.js";
import { openDb } from "../src/persistence/db.js";
import { runBlobDir } from "../src/persistence/paths.js";
import { insertReuseRun, insertRun } from "../src/persistence/run-store.js";

/**
 * The continuation recipe Resume and Complete share (#architecture-deepening). These pin the four
 * answers `continuation.ts` owns — the reuse-row swap, the blob reader, the recovered launch facts, and
 * the successor-root capture — because both engine entry points read them and neither may drift.
 */

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "path-engine-continuation-test-"));
  db = openDb(join(dir, "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A row to insert: only the fields these tests care about, the rest left at their column defaults. */
function newRow(runId: string, parentRunId: string | null, rootRunId = "root-1") {
  return { runId, rootRunId, parentRunId, nodeId: `node-${runId}`, nodeName: runId, workerName: null, status: "running" as const };
}

/** The same row as the reader sees it, with the fields `sourceRuns` reads named explicitly. */
function record(runId: string, parentRunId: string | null, rootRunId = "root-1", extra: Partial<RunRecord> = {}): RunRecord {
  return { ...newRow(runId, parentRunId, rootRunId), finishedAt: null, inputRef: null, outputRef: null, reusedFromRunId: null, ...extra } as unknown as RunRecord;
}

describe("sourceRuns", () => {
  it("swaps a reuse row for its source record, keeping the reuse row's own parent", () => {
    insertRun(db, newRow("root-1", null));
    insertRun(db, { ...newRow("step-1", "root-1"), status: "succeeded" });
    insertReuseRun(db, {
      runId: "reuse-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "node-step-1",
      nodeName: "step-1",
      reusedFromRunId: "step-1",
    });

    const swapped = sourceRuns(db, [record("reuse-1", "root-1", "root-1", { reusedFromRunId: "step-1" })]);

    // The reuse row keeps the parent it sat under, but names the source's run and tree from now on.
    expect(swapped[0]).toMatchObject({ runId: "step-1", rootRunId: "root-1", parentRunId: "root-1", status: "succeeded" });
  });

  it("drops a reuse row whose source is gone, so that node re-executes", () => {
    expect(sourceRuns(db, [record("reuse-1", "root-1", "root-1", { reusedFromRunId: "vanished" })])).toEqual([]);
  });

  it("passes an ordinary row through unchanged", () => {
    const ordinary = record("step-1", "root-1");

    expect(sourceRuns(db, [ordinary])).toEqual([ordinary]);
  });
});

describe("continuationBlobReader", () => {
  it("reads out of the tree the record names, which is the source tree for a swapped reuse row", () => {
    const reader = continuationBlobReader(dir);
    for (const [rootRunId, value] of [
      ["source-root", { from: "source" }],
      ["other-root", { from: "other" }],
    ] as const) {
      const blobDir = runBlobDir(dir, rootRunId, "step-1");
      mkdirSync(blobDir, { recursive: true });
      writeFileSync(join(blobDir, "output.json"), JSON.stringify(value));
    }

    expect(reader(record("step-1", "parent-1", "source-root"), "output.json")).toEqual({ from: "source" });
    expect(reader(record("step-1", "parent-1", "other-root"), "output.json")).toEqual({ from: "other" });
  });
});

describe("continuationRunOptions", () => {
  const frozen: LaunchFacts = {
    config: { model: "frozen-model", token: "[secret:token]" },
    workerDefaults: { prompt: "sdk" },
    secretKeys: ["token"],
  };

  it("recovers the frozen config and the launch worker-default table when the caller supplies nothing", () => {
    const options = continuationRunOptions({ rerunFromRunId: "run-7" }, frozen);

    expect(options.operatorConfig).toEqual({ model: "frozen-model", token: "[secret:token]" });
    expect(options.launchWorkerDefaults).toEqual({ prompt: "sdk" });
    expect(options.inheritedLaunchSecretKeys).toEqual(["token"]);
    // The frozen input is shown to a reader, never replayed: a continuation restores the context.
    expect(options.operatorInput).toBeUndefined();
  });

  it("consumes the rerun boundary, which is a Resume's business and never a run option", () => {
    expect(continuationRunOptions({ rerunFromRunId: "run-7" }, undefined)).not.toHaveProperty("rerunFromRunId");
  });

  it("merges a supplied value over the frozen one and re-marks a supplied secret at its recorded path", () => {
    const options = continuationRunOptions({ operatorConfig: { model: "supplied-model", token: "real-credential" } }, frozen);

    expect(options.operatorConfig).toEqual({ model: "supplied-model", token: { $secret: "real-credential" } });
    // Supplied again, so nothing is missing — the run must not end at its first step naming the key.
    expect(options.unresolvedLaunchSecrets).toEqual([]);
  });

  it("reports a frozen secret the caller did not supply again", () => {
    const options = continuationRunOptions({ operatorConfig: { model: "only-a-model" } }, frozen);

    expect(options.unresolvedLaunchSecrets).toEqual(["token"]);
  });
});

describe("successorCapture", () => {
  const started = (runId: string, parentRunId: string | null): Observation => ({
    type: "run-started",
    runId,
    rootRunId: parentRunId === null ? runId : "root-2",
    parentRunId,
    nodeId: null,
    nodeName: null,
    input: {},
  });

  it("captures the successor's own root run, ignoring a nested run's start", () => {
    const capture = successorCapture();

    capture.observer.observe(started("nested-1", "root-2"));
    capture.observer.observe(started("root-2", null));

    expect(capture.rootRunId()).toBe("root-2");
  });

  it("throws rather than returning an id it never saw", () => {
    expect(() => successorCapture().rootRunId()).toThrow(/emitted no root run-started/);
  });
});

/** A node the disposition adapters read: only the two fields they look at, cast to the body-node type. */
function node(id: string, type = "binary"): Parameters<ReturnType<typeof continuationOf>["disposition"]>[0] {
  return { id, type } as unknown as Parameters<ReturnType<typeof continuationOf>["disposition"]>[0];
}

/** A RunContext carrying only what `continuationOf`/`disposition` read: identity, and one of resume/continue. */
function runCtx(parts: Pick<RunContext, "identity"> & Partial<Pick<RunContext, "resume" | "continue">>): RunContext {
  return parts as unknown as RunContext;
}

/** A Complete-continue state over a fixed row set, targeting one parked leaf by id. */
function continueState(existingRuns: RunRecord[], targetStepRunId: string): ContinueState {
  return { existingRuns, readBlob: () => ({}), target: { stepRunId: targetStepRunId, output: {} } };
}

describe("continuationOf — Resume adapter", () => {
  const identity = { runId: "wf-1" } as RunContext["identity"];

  it("reuses a node the plan holds, and runs every other node fresh", () => {
    const original = record("orig-1", "wf-1");
    const resume = { plan: new Map([["a", original]]) } as unknown as RunContext["resume"];
    const c = continuationOf(runCtx({ identity, resume }));

    expect(c.disposition(node("a"))).toEqual({ kind: "reuse", original });
    expect(c.disposition(node("b"))).toEqual({ kind: "fresh" });
  });

  it("answers fresh everywhere for a plain forward run (no resume, no continue)", () => {
    const c = continuationOf(runCtx({ identity }));
    expect(c.disposition(node("a"))).toEqual({ kind: "fresh" });
  });
});

describe("continuationOf — Complete adapter", () => {
  const identity = { runId: "parent-1" } as RunContext["identity"];
  const complete = (rows: RunRecord[], target: string) =>
    continuationOf(runCtx({ identity, continue: continueState(rows, target) }));

  it("reuses a succeeded row read-only", () => {
    const existing = record("r1", "parent-1", "root-1", { nodeId: "a", status: "succeeded" });
    expect(complete([existing], "none").disposition(node("a"))).toEqual({ kind: "succeeded", existing });
  });

  it("completes the parked target leaf, but parks another parked sibling", () => {
    const target = record("r-target", "parent-1", "root-1", { nodeId: "a", status: "awaiting" });
    const sibling = record("r-sib", "parent-1", "root-1", { nodeId: "b", status: "awaiting" });
    const c = complete([target, sibling], "r-target");

    expect(c.disposition(node("a"))).toEqual({ kind: "complete", existing: target });
    expect(c.disposition(node("b"))).toEqual({ kind: "park" });
  });

  it("re-enters a non-terminal workflow-run row, but runs a non-terminal leaf fresh", () => {
    const wfRow = record("r-wf", "parent-1", "root-1", { nodeId: "a", status: "running" });
    const leafRow = record("r-leaf", "parent-1", "root-1", { nodeId: "b", status: "running" });
    const c = complete([wfRow, leafRow], "none");

    expect(c.disposition(node("a", "workflow"))).toEqual({ kind: "reenter", existing: wfRow });
    expect(c.disposition(node("b", "binary"))).toEqual({ kind: "fresh" });
  });

  it("runs fresh when no row under this parent answers the node", () => {
    const elsewhere = record("r1", "other-parent", "root-1", { nodeId: "a", status: "succeeded" });
    expect(complete([elsewhere], "none").disposition(node("a"))).toEqual({ kind: "fresh" });
  });
});
