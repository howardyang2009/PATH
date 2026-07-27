import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { readJsonBlob } from "../../src/persistence/blob-store.js";
import { runBlobDir } from "../../src/persistence/paths.js";
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

describe("createPersistedObserver", () => {
  it("records the root run row and its input/context blobs on runStarted", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: { seed: 1 }, worker: { type: "engine" } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row).toMatchObject({
      runId: "root-1",
      rootRunId: "root-1",
      parentRunId: null,
      nodeId: null,
      worker: null,
      status: "running",
    });
    expect(row?.inputRef).toBe(join("runs", "root-1", "root-1", "input.json"));

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(readJsonBlob(dir, "input.json")).toEqual({ seed: 1 });
    expect(readJsonBlob(dir, "context.json")).toEqual({ seed: 1 });
  });

  it("records a step run row and its input blob on stepStarted, scoped under the root run", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      stepType: "binary",
      worker: { type: "engine" },
      input: "hi",
    });

    const rows = getRunsForRoot(db, "root-1");
    const step = rows.find((r) => r.runId === "step-1");
    expect(step).toMatchObject({
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      worker: { type: "engine" },
      status: "running",
    });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readJsonBlob(dir, "input.json")).toBe("hi");
  });

  it("writes stderr.txt for a step, even when empty", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      stepType: "binary",
      worker: { type: "engine" },
      input: {},
    });
    await observer.observe({ type: "step-stderr", runId: "step-1", rootRunId: "root-1", stderr: "warning: x\n" });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(readFileSync(join(dir, "stderr.txt"), "utf8")).toBe("warning: x\n");
  });

  it("marks a step succeeded and writes its output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      stepType: "binary",
      worker: { type: "engine" },
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
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "boom",
      stepType: "binary",
      worker: { type: "engine" },
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
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "context-changed", runId: "root-1", rootRunId: "root-1", context: { greeting: "hi" } });

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(readJsonBlob(dir, "context.json")).toEqual({ greeting: "hi" });
  });

  it("marks the root run succeeded and writes its output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "succeeded", output: { final: "x" } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("succeeded");
    expect(row?.outputRef).toBe(join("runs", "root-1", "root-1", "output.json"));
    expect(readJsonBlob(runBlobDir(projectDir, "root-1", "root-1"), "output.json")).toEqual({ final: "x" });
  });

  it("marks the root run failed without writing an output blob", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "run-finished", runId: "root-1", rootRunId: "root-1", status: "failed" });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("failed");
    expect(row?.outputRef).toBeNull();
  });

  it("records an LLM step run's usage and estimated cost on its own row (mvp spec §5.7)", async () => {
    const observer = createPersistedObserver(db, projectDir);
    await observer.observe({ type: "run-started", runId: "root-1", rootRunId: "root-1", parentRunId: null, nodeId: null, input: {}, worker: { type: "engine" } });
    await observer.observe({ type: "step-started",
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "summarize",
      stepType: "prompt",
      worker: { type: "llm", model: "claude-sonnet-5" },
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
