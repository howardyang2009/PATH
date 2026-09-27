import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@path/schema";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonBlob } from "../../src/persistence/blob-store.js";
import { openDb } from "../../src/persistence/db.js";
import { pathDir, runBlobDir } from "../../src/persistence/paths.js";
import { createPersistedObserver } from "../../src/persistence/persisted-observer.js";
import { getLaunchWorkerDefaults, getRunsForRoot } from "../../src/persistence/run-store.js";
import type { RunIdentity } from "../../src/run-context.js";
import { createEmitter, type Emitter } from "../../src/run-emitter.js";

let projectDir: string;
let db: Database.Database;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-persisted-observer-test-"));
  db = openDb(join(projectDir, ".path", "path.db"));
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

/** Resolve a ref the way a reader would: it is relative to `.path/`, forward-slash-joined. */
function fileForRef(ref: string): string {
  return join(pathDir(projectDir), ...ref.split("/"));
}

const ROOT: RunIdentity = {
  runId: "root-1",
  rootRunId: "root-1",
  parentRunId: null,
  nodeId: null,
  nodeName: null,
};

/** The root run's emitter over a fresh persisted observer, the way the engine drives it. */
function rootEmitter(): Emitter {
  const observer = createPersistedObserver(db, projectDir);
  return createEmitter(ROOT, async (e) => {
    await observer.observe(e);
  });
}

/** A started root plus one started leaf step `step-1` on node `id`. */
async function rootWithStep(
  id: string,
  input: JsonValue = {},
  stepType = "binary",
  workerName = "spawn",
) {
  const root = rootEmitter();
  await root.runStarted({ input: {} });
  const step = root.step({ id, name: id }, "step-1");
  await step.started({ stepType, workerName, input });
  return { root, step };
}

const rowOf = (runId: string) => getRunsForRoot(db, "root-1").find((r) => r.runId === runId);

describe("createPersistedObserver", () => {
  it("records the root run row and its input/context blobs on its start", async () => {
    await rootEmitter().runStarted({ input: { seed: 1 } });

    expect(rowOf("root-1")).toMatchObject({
      runId: "root-1",
      rootRunId: "root-1",
      parentRunId: null,
      nodeId: null,
      nodeName: null,
      workerName: null,
      status: "running",
    });
    expect(rowOf("root-1")?.inputRef).toBe(join("runs", "root-1", "root-1", "input.json"));

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(readJsonBlob(dir, "input.json")).toEqual({ seed: 1 });
    expect(readJsonBlob(dir, "context.json")).toEqual({ seed: 1 });
  });

  // The launch worker-default table is frozen on the root row (ADR 0044): the root start carries it,
  // persistence records it, and a resume reads it back to re-resolve a re-run step.
  it("records the launch worker-default table carried by a root start", async () => {
    await rootEmitter().runStarted({
      input: {},
      launchFacts: { workerDefaults: { prompt: "deepseek" } },
    });

    expect(getLaunchWorkerDefaults(db, "root-1")).toEqual({ prompt: "deepseek" });
  });

  it("records a nested workflow-run with no worker of its own, its input seeding its context", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root
      .child({
        runId: "child-1",
        rootRunId: "root-1",
        parentRunId: "root-1",
        nodeId: "invoke",
        nodeName: "invoke",
      })
      .runStarted({ input: { k: 1 } });

    expect(rowOf("child-1")).toMatchObject({
      parentRunId: "root-1",
      nodeId: "invoke",
      workerName: null,
    });
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "child-1"), "context.json")).toEqual({
      k: 1,
    });
  });

  it("seeds no context for a goto pass container, which shares its workflow-run's", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root
      .child({ ...ROOT, runId: "pass-1", parentRunId: "root-1", pass: 1 })
      .runStarted({ input: { k: 1 } });

    expect(rowOf("pass-1")).toMatchObject({ pass: 1 });
    expect(existsSync(join(runBlobDir(projectDir, "root-1", "pass-1"), "context.json"))).toBe(
      false,
    );
  });

  it("records a step run row and its input blob on its start, scoped under the root run", async () => {
    await rootWithStep("greet", "hi");

    expect(rowOf("step-1")).toMatchObject({
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      nodeName: "greet",
      workerName: "spawn",
      status: "running",
    });
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "step-1"), "input.json")).toBe("hi");
  });

  it("writes stderr.txt for a step", async () => {
    const { step } = await rootWithStep("greet");
    await step.record({ kind: "stderr", stderr: "warning: x\n" });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readFileSync(join(dir, "stderr.txt"), "utf8")).toBe("warning: x\n");
  });

  it("marks a step succeeded and writes its output blob", async () => {
    const { step } = await rootWithStep("greet");
    await step.finished({ status: "succeeded", output: "hi" });

    const row = rowOf("step-1");
    expect(row?.status).toBe("succeeded");
    expect(row?.finishedAt).toBeTruthy();
    expect(row?.outputRef).toBe(join("runs", "root-1", "step-1", "output.json"));
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "step-1"), "output.json")).toBe("hi");
  });

  it("marks a step failed without writing an output blob", async () => {
    const { step } = await rootWithStep("boom");
    await step.finished({ status: "failed" });

    expect(rowOf("step-1")?.status).toBe("failed");
    expect(rowOf("step-1")?.outputRef).toBeNull();
  });

  it("marks a cancelled step cancelled, its run-cancelled writing nothing", async () => {
    const { step } = await rootWithStep("slow");
    await step.cancelled({ cause: "operator", causeRunId: null });

    expect(rowOf("step-1")?.status).toBe("cancelled");
  });

  it("marks a parked step awaiting", async () => {
    const { step } = await rootWithStep("review");
    await step.emit({ type: "step-awaiting", assignee: null });

    expect(rowOf("step-1")?.status).toBe("awaiting");
  });

  it("records a reused node as a succeeded reuse row under the enclosing run", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.emit(
      { id: "greet", name: "greet" },
      { type: "reuse-marker", original_run_id: "orig" },
    );

    const reuse = getRunsForRoot(db, "root-1").find((r) => r.runId !== "root-1");
    expect(reuse).toMatchObject({
      parentRunId: "root-1",
      nodeId: "greet",
      status: "succeeded",
      reusedFromRunId: "orig",
    });
  });

  it("rewrites the root run's context.json on a context change", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.record({ kind: "context", context: { greeting: "hi" } });

    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "context.json")).toEqual({
      greeting: "hi",
    });
  });

  it("writes a leaf step's own context.json snapshot under that step's directory", async () => {
    const { step } = await rootWithStep("greet");
    await step.finished({ status: "succeeded", output: "HI" });
    await step.record({ kind: "context", context: { greeting: "hi", shouted: "HI" } });

    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "step-1"), "context.json")).toEqual({
      greeting: "hi",
      shouted: "HI",
    });
    // The workflow-run's own context.json (seeded at its start as `{}`) is untouched by a step's
    // snapshot — the step writes under its own directory, not the workflow-run's.
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "context.json")).toEqual({});
  });

  it("marks the root run succeeded and writes its output blob", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.runFinished({ status: "succeeded", output: { final: "x" } });

    const row = rowOf("root-1");
    expect(row?.status).toBe("succeeded");
    expect(row?.outputRef).toBe(join("runs", "root-1", "root-1", "output.json"));
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "output.json")).toEqual({
      final: "x",
    });
  });

  it("marks the root run failed without writing an output blob", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.runFinished({ status: "failed" });

    expect(rowOf("root-1")?.status).toBe("failed");
    expect(rowOf("root-1")?.outputRef).toBeNull();
  });

  /**
   * The defect the write side exists to make unrepresentable: the blob's directory and the row's ref
   * built separately could address different files with no error. Comparing the ref to a literal
   * would not catch that; resolving it does.
   */
  it("records an input ref that resolves to the file it just wrote", async () => {
    await rootEmitter().runStarted({ input: { seed: 1 } });

    const row = rowOf("root-1");
    expect(row?.inputRef).not.toBeNull();
    expect(existsSync(fileForRef(row!.inputRef!))).toBe(true);
    expect(JSON.parse(readFileSync(fileForRef(row!.inputRef!), "utf8"))).toEqual({ seed: 1 });
  });

  it("records an output ref that resolves to the file it just wrote", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.runFinished({ status: "succeeded", output: { done: true } });

    const row = rowOf("root-1");
    expect(JSON.parse(readFileSync(fileForRef(row!.outputRef!), "utf8"))).toEqual({ done: true });
  });

  it("seeds no context for a leaf step run — only a workflow-run's input seeds one", async () => {
    await rootWithStep("greet", "hi");

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(existsSync(join(dir, "input.json"))).toBe(true);
    expect(existsSync(join(dir, "context.json"))).toBe(false);
  });

  it("writes no output.json for a failed run — not merely a null ref", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.runFinished({ status: "failed", error: "boom" });

    expect(existsSync(join(runBlobDir(projectDir, "root-1", "root-1"), "output.json"))).toBe(false);
  });

  it("captures empty stderr — it is audit, not a payload", async () => {
    const root = rootEmitter();
    await root.runStarted({ input: {} });
    await root.record({ kind: "stderr", stderr: "" });

    expect(
      readFileSync(join(runBlobDir(projectDir, "root-1", "root-1"), "stderr.txt"), "utf8"),
    ).toBe("");
  });

  it("records an LLM step run's usage and estimated cost on its own row (mvp spec §5.7)", async () => {
    const { step } = await rootWithStep("summarize", {}, "prompt", "anthropic");
    await step.record({
      kind: "usage",
      usage: { input_tokens: 12, output_tokens: 34 },
      estimatedCostUsd: 0.0053,
    });

    expect(rowOf("step-1")?.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(rowOf("step-1")?.estimatedCostUsd).toBeCloseTo(0.0053);

    // Leaf-only: the enclosing workflow-run stores no derived total of its children's spend.
    expect(rowOf("root-1")?.usage).toBeNull();
    expect(rowOf("root-1")?.estimatedCostUsd).toBeNull();
  });
});
