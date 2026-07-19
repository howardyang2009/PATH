import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const realFixtures = join(packageRoot, "test", "fixtures");
const bin = join(packageRoot, "bin", "path.ts");

// `path run` now writes a real .path/ (db + blobs) beside the workflow file (ticket #18) — run
// against a throwaway copy of the fixtures so tests never leave state in the checked-in tree.
let fixtures: string;

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "path-engine-cli-e2e-test-"));
  cpSync(realFixtures, fixtures, { recursive: true });
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
});

function runCli(args: string[], cwd: string = packageRoot) {
  return execFileAsync("npx", ["tsx", bin, ...args], { cwd });
}

describe("path run (real dev-mode process, no packaging)", () => {
  it("runs a two-binary-step workflow end to end via tsx", async () => {
    const { stdout } = await runCli(["run", join(fixtures, "two-binary-steps.workflow.json")]);
    expect(stdout.trim()).toBe(JSON.stringify({ shouted: "HELLO" }));
  });

  it("exits non-zero with load errors surfaced, running nothing", async () => {
    await expect(runCli(["run", join(fixtures, "invalid-schema.workflow.json")])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("bogus_field"),
    });
  });

  it("exits non-zero when a step fails, and does not run subsequent steps", async () => {
    await expect(runCli(["run", join(fixtures, "failing-step.workflow.json")])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("boom"),
    });
  });
});

describe("path run persistence + runs rm/prune (ticket #18, real dev-mode process)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-persistence-e2e-"));
    cpSync(join(realFixtures, "two-binary-steps.workflow.json"), join(projectDir, "workflow.json"));
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Each test in this block leaves a run behind; keep them isolated with prune.
    rmSync(join(projectDir, ".path"), { recursive: true, force: true });
  });

  it("leaves a run row and its blobs on disk, and .path/ is self-gitignored", async () => {
    await runCli(["run", join(projectDir, "workflow.json")], projectDir);

    expect(readFileSync(join(projectDir, ".path", ".gitignore"), "utf8")).toBe("*\n");

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const rows = db.prepare("SELECT * FROM runs").all() as {
      run_id: string;
      root_run_id: string;
      status: string;
      output_ref: string | null;
    }[];
    db.close();
    expect(rows.length).toBeGreaterThanOrEqual(2); // root run + at least one step run
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);

    const rootRow = rows.find((r) => r.run_id === r.root_run_id);
    expect(rootRow?.output_ref).toBeTruthy();
    expect(existsSync(join(projectDir, ".path", "runs", rootRow!.root_run_id))).toBe(true);
  });

  it("path runs rm <root-run-id> removes both the rows and the directory", async () => {
    await runCli(["run", join(projectDir, "workflow.json")], projectDir);

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const rootRunId = (db.prepare("SELECT root_run_id FROM runs LIMIT 1").get() as { root_run_id: string })
      .root_run_id;
    db.close();

    const { stdout } = await runCli(["runs", "rm", rootRunId], projectDir);
    expect(stdout).toMatch(/removed/);

    const dbAfter = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const remaining = dbAfter.prepare("SELECT * FROM runs WHERE root_run_id = ?").all(rootRunId);
    dbAfter.close();
    expect(remaining).toHaveLength(0);
    expect(existsSync(join(projectDir, ".path", "runs", rootRunId))).toBe(false);
  });

  it("path runs prune removes every root run's rows and directories", async () => {
    await runCli(["run", join(projectDir, "workflow.json")], projectDir);
    await runCli(["run", join(projectDir, "workflow.json")], projectDir);

    const { stdout } = await runCli(["runs", "prune"], projectDir);
    expect(stdout).toMatch(/pruned/);

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const remaining = db.prepare("SELECT * FROM runs").all();
    db.close();
    expect(remaining).toHaveLength(0);
  });

  it("path runs rm cleans up an orphaned run directory that has no matching db rows", async () => {
    const orphanId = "orphan-run-id";
    mkdirSync(join(projectDir, ".path", "runs", orphanId), { recursive: true });
    writeFileSync(join(projectDir, ".path", "runs", orphanId, "input.json"), "{}");

    const { stdout } = await runCli(["runs", "rm", orphanId], projectDir);
    expect(stdout).toMatch(/removed/);
    expect(existsSync(join(projectDir, ".path", "runs", orphanId))).toBe(false);
  });

  it("path runs rm reports a clear error for an id present in neither store", async () => {
    await expect(runCli(["runs", "rm", "never-existed"], projectDir)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("no run found"),
    });
  });
});

describe("path run with a nested workflow step (ticket #22, real dev-mode process)", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-nested-e2e-"));
    for (const f of ["nested-parent.workflow.json", "nested-child.workflow.json"]) {
      cpSync(join(realFixtures, f), join(projectDir, f));
    }
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("runs the child, returns the child's output map to the parent, and mirrors the run tree in db + on disk", async () => {
    const { stdout } = await runCli(["run", join(projectDir, "nested-parent.workflow.json")], projectDir);
    // The parent's `publish` captured the child's `output` map verbatim.
    expect(stdout.trim()).toBe(JSON.stringify({ childResult: { shouted: "HI" } }));

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const rows = db.prepare("SELECT * FROM runs ORDER BY started_at").all() as {
      run_id: string;
      root_run_id: string;
      parent_run_id: string | null;
      node_id: string | null;
      status: string;
    }[];
    db.close();

    expect(rows.every((r) => r.status === "succeeded")).toBe(true);

    // The run tree: root workflow-run -> child workflow-run ("child-step") -> leaf binary ("shout").
    const root = rows.find((r) => r.parent_run_id === null);
    expect(root).toBeTruthy();
    expect(root!.node_id).toBeNull();
    expect(root!.run_id).toBe(root!.root_run_id);

    const childRun = rows.find((r) => r.node_id === "child-step");
    expect(childRun).toBeTruthy();
    expect(childRun!.parent_run_id).toBe(root!.run_id);
    expect(childRun!.root_run_id).toBe(root!.run_id);

    const leafRun = rows.find((r) => r.node_id === "shout");
    expect(leafRun).toBeTruthy();
    expect(leafRun!.parent_run_id).toBe(childRun!.run_id);
    expect(leafRun!.root_run_id).toBe(root!.run_id);

    // Every workflow-run has its own context.json in its own run subdirectory under the one root
    // run's tree; the leaf binary run has stderr.txt but no context of its own.
    const runsRoot = join(projectDir, ".path", "runs", root!.root_run_id);
    expect(existsSync(join(runsRoot, root!.run_id, "context.json"))).toBe(true);
    expect(existsSync(join(runsRoot, childRun!.run_id, "context.json"))).toBe(true);
    expect(existsSync(join(runsRoot, leafRun!.run_id, "context.json"))).toBe(false);
    expect(existsSync(join(runsRoot, leafRun!.run_id, "stderr.txt"))).toBe(true);

    // The child's context.json is its own isolated blackboard — it holds the input-seeded key and
    // the child's own publish, and nothing from the parent.
    const childContext = JSON.parse(readFileSync(join(runsRoot, childRun!.run_id, "context.json"), "utf8"));
    expect(childContext).toEqual({ seed: "hi", shouted: "HI" });
  });
});
