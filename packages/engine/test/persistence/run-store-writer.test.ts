import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { dbFilePath, pathDir, runBlobDir } from "../../src/persistence/paths.js";
import { getRunsForRoot } from "../../src/persistence/run-store.js";
import { createRunStore, type RunStore } from "../../src/persistence/run-store-writer.js";

let projectDir: string;
let db: Database.Database;
let store: RunStore;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "path-engine-run-store-test-"));
  db = openDb(dbFilePath(projectDir));
  store = createRunStore(db, projectDir);
});

afterEach(() => {
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

const rootFact = {
  runId: "root-1",
  rootRunId: "root-1",
  parentRunId: null,
  nodeId: null,
  worker: null,
  input: { seed: 1 },
  seedsContext: true,
};

/** Resolve a ref the way a reader would: it is relative to `.path/`, forward-slash-joined. */
function fileForRef(ref: string): string {
  return join(pathDir(projectDir), ...ref.split("/"));
}

describe("createRunStore — one call per run fact", () => {
  it("records a workflow-run's row, input and seeded context in one call", () => {
    store.runStarted(rootFact);

    const [row] = getRunsForRoot(db, "root-1");
    expect(row).toMatchObject({ runId: "root-1", status: "running", worker: null });

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(JSON.parse(readFileSync(join(dir, "input.json"), "utf8"))).toEqual({ seed: 1 });
    // A workflow-run's input seeds its context (format §6.3).
    expect(JSON.parse(readFileSync(join(dir, "context.json"), "utf8"))).toEqual({ seed: 1 });
  });

  it("does not seed a context for a leaf step run", () => {
    store.runStarted(rootFact);
    store.runStarted({
      runId: "step-1",
      rootRunId: "root-1",
      parentRunId: "root-1",
      nodeId: "greet",
      worker: { type: "engine" },
      input: "hi",
      seedsContext: false,
    });

    const dir = runBlobDir(projectDir, "root-1", "step-1");
    expect(existsSync(join(dir, "input.json"))).toBe(true);
    expect(existsSync(join(dir, "context.json"))).toBe(false);
  });

  /**
   * The defect the store exists to make unrepresentable (#72). The blob's directory and the row's
   * ref were built separately, from the same pieces, with different separator conventions — so they
   * could address different files with no error and no failing test. They come from one call now.
   */
  it("records an input ref that resolves to the file it just wrote", () => {
    store.runStarted(rootFact);

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.inputRef).not.toBeNull();
    expect(existsSync(fileForRef(row!.inputRef!))).toBe(true);
    expect(JSON.parse(readFileSync(fileForRef(row!.inputRef!), "utf8"))).toEqual({ seed: 1 });
  });

  it("records an output ref that resolves to the file it just wrote", () => {
    store.runStarted(rootFact);
    store.runFinished("root-1", "root-1", { status: "succeeded", output: { done: true } });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("succeeded");
    expect(JSON.parse(readFileSync(fileForRef(row!.outputRef!), "utf8"))).toEqual({ done: true });
  });

  it("writes no output blob for a failed or cancelled run", () => {
    store.runStarted(rootFact);
    store.runFinished("root-1", "root-1", { status: "failed", error: "boom" });

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.status).toBe("failed");
    expect(row?.outputRef).toBeNull();
    expect(existsSync(join(runBlobDir(projectDir, "root-1", "root-1"), "output.json"))).toBe(false);
  });

  it("rewrites context.json on every change, so on-disk state matches the live blackboard", () => {
    store.runStarted(rootFact);
    store.contextChanged("root-1", "root-1", { seed: 1, added: "later" });

    const dir = runBlobDir(projectDir, "root-1", "root-1");
    expect(JSON.parse(readFileSync(join(dir, "context.json"), "utf8"))).toEqual({ seed: 1, added: "later" });
  });

  it("captures stderr even when empty — it is audit, not a payload", () => {
    store.runStarted(rootFact);
    store.stderrCaptured("root-1", "root-1", "");
    expect(readFileSync(join(runBlobDir(projectDir, "root-1", "root-1"), "stderr.txt"), "utf8")).toBe("");
  });

  it("records usage on the row where the tokens were spent", () => {
    store.runStarted(rootFact);
    store.usageRecorded("root-1", { input_tokens: 9 }, 0.02);

    const [row] = getRunsForRoot(db, "root-1");
    expect(row?.usage).toEqual({ input_tokens: 9 });
    expect(row?.estimatedCostUsd).toBe(0.02);
  });
});
