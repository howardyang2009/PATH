import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { readJsonBlob } from "../../src/persistence/blob-store.js";
import { pathDir, runBlobDir } from "../../src/persistence/paths.js";
import { createPersistedObserver } from "../../src/persistence/persisted-observer.js";
import { getRunsForRoot } from "../../src/persistence/run-store.js";

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

describe("createPersistedObserver", () => {
  it("records the root run row and its input/context blobs on runStarted", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: { seed: 1 } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row).toMatchObject({
      runId: "root-1",
      rootRunId: "root-1",
      parentRunId: null,
      nodeId: null, nodeName: null,
      workerName: null,
      status: "running",
    });
    expect(row?.inputRef).toBe(join("runs", "root-1", "root-1", "input.json"));

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(readJsonBlob(dir, "input.json")).toEqual({ seed: 1 });
    expect(readJsonBlob(dir, "context.json")).toEqual({ seed: 1 });
  });

  it("records a step run row and its input blob on stepStarted, scoped under the root run", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      stepType: "binary",
      workerName: "spawn",
      input: "hi",
    });

    const rows = getRunsForRoot(db, "root-1");
    const step = rows.find((r) => r.runId === "step-1");
    expect(step).toMatchObject({
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      workerName: "spawn",
      status: "running",
    });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readJsonBlob(dir, "input.json")).toBe("hi");
  });

  it("writes stderr.txt for a step, even when empty", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      stepType: "binary",
      workerName: "spawn",
      input: {},
    });
    await observer.observe({ type: "step-stderr", runId: "step-1", rootRunId: "root-1", stderr: "warning: x\n" });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readFileSync(join(dir, "stderr.txt"), "utf8")).toBe("warning: x\n");
  });

  it("marks a step succeeded and writes its output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      stepType: "binary",
      workerName: "spawn",
      input: {},
    });
    await observer.observe({ type: "step-finished", runId: "step-1", rootRunId: "root-1", status: "succeeded", output: "hi" });

    const rows = getRunsForRoot(db, "root-1");
    const step = rows.find((r) => r.runId === "step-1");
    expect(step?.status).toBe("succeeded");
    expect(step?.finishedAt).toBeTruthy();
    expect(step?.outputRef).toBe(join("runs", "root-1", "step-1", "output.json"));

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readJsonBlob(dir, "output.json")).toBe("hi");
  });

  it("marks a step failed without writing an output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "boom", nodeName: "boom",
      stepType: "binary",
      workerName: "spawn",
      input: {},
    });
    await observer.observe({ type: "step-finished", runId: "step-1", rootRunId: "root-1", status: "failed" });

    const rows = getRunsForRoot(db, "root-1");
    const step = rows.find((r) => r.runId === "step-1");
    expect(step?.status).toBe("failed");
    expect(step?.outputRef).toBeNull();
  });

  it("rewrites the root run's context.json on contextChanged", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "context-changed", runId: "root-1", rootRunId: "root-1", context: { greeting: "hi" } });

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(readJsonBlob(dir, "context.json")).toEqual({ greeting: "hi" });
  });

  it("writes a leaf step's own context.json on stepContext, under that step's directory", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      stepType: "binary",
      workerName: "spawn",
      input: {},
    });
    await observer.observe({ type: "step-finished", runId: "step-1", rootRunId: "root-1", status: "succeeded", output: "HI" });
    // The per-step snapshot lands under the step run's own directory (`runId: "step-1"`), not the
    // workflow-run's — so the step's input/output pair gains a context companion of its own.
    await observer.observe({ type: "step-context", runId: "step-1", rootRunId: "root-1", context: { greeting: "hi", shouted: "HI" } });

    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "step-1"), "context.json")).toEqual({ greeting: "hi", shouted: "HI" });
    // The workflow-run's own context.json (seeded at run-started as `{}`) is untouched by a step's
    // snapshot — the step writes under its own directory, not the workflow-run's.
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "context.json")).toEqual({});
  });

  it("marks the root run succeeded and writes its output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "succeeded", output: { final: "x" } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("succeeded");
    expect(row?.outputRef).toBe(join("runs", "root-1", "root-1", "output.json"));
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "output.json")).toEqual({ final: "x" });
  });

  it("marks the root run failed without writing an output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "failed" });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("failed");
    expect(row?.outputRef).toBeNull();
  });

  /**
   * The defect the write side exists to make unrepresentable (#72). The blob's directory and the
   * row's ref were built separately, from the same pieces, with different separator conventions —
   * so they could address different files with no error and no failing test. Comparing the ref to
   * a literal would not catch that; resolving it does.
   */
  it("records an input ref that resolves to the file it just wrote", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: { seed: 1 } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.inputRef).not.toBeNull();
    expect(existsSync(fileForRef(row!.inputRef!))).toBe(true);
    expect(JSON.parse(readFileSync(fileForRef(row!.inputRef!), "utf8"))).toEqual({ seed: 1 });
  });

  it("records an output ref that resolves to the file it just wrote", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "succeeded", output: { done: true } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(JSON.parse(readFileSync(fileForRef(row!.outputRef!), "utf8"))).toEqual({ done: true });
  });

  it("seeds no context for a leaf step run — only a workflow-run's input seeds one", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet", nodeName: "greet",
      stepType: "binary",
      workerName: "spawn",
      input: "hi",
    });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(existsSync(join(dir, "input.json"))).toBe(true);
    expect(existsSync(join(dir, "context.json"))).toBe(false);
  });

  it("writes no output.json for a failed run — not merely a null ref", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "failed", error: "boom" });

    expect(existsSync(join(runBlobDir(projectDir, "root-1", "root-1"), "output.json"))).toBe(false);
  });

  it("captures empty stderr — it is audit, not a payload", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-stderr", runId: "root-1", rootRunId: "root-1", stderr: "" });

    expect(readFileSync(join(runBlobDir(projectDir, "root-1", "root-1"), "stderr.txt"), "utf8")).toBe("");
  });

  it("records an LLM step run's usage and estimated cost on its own row (mvp spec §5.7)", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, nodeName: null, input: {} });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "summarize", nodeName: "summarize",
      stepType: "prompt",
      workerName: "sdk",
      input: {},
    });
    await observer.observe({ type: "step-usage",
      runId: "step-1",
      rootRunId: "root-1",
      usage: { input_tokens: 12, output_tokens: 34 },
      estimatedCostUsd: 0.0053,
    });

    const step = getRunsForRoot(db, "root-1").find((r) => r.runId === "step-1");
    expect(step?.usage).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(step?.estimatedCostUsd).toBeCloseTo(0.0053);

    // Leaf-only: the enclosing workflow-run stores no derived total of its children's spend.
    const root = getRunsForRoot(db, "root-1").find((r) => r.runId === "root-1");
    expect(root?.usage).toBeNull();
    expect(root?.estimatedCostUsd).toBeNull();
  });
});
