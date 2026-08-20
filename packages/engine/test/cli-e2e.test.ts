import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { stampGuids } from "./stamp-names.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Every test here spawns one or more *cold* `npx tsx` subprocesses (see `runCli`), and some spawn
// three (two `run`s + a `prune`/`rm`). On a loaded CI runner that cold start alone can exceed the
// default 5s vitest `testTimeout`, tripping unrelated PRs (#220). A timeout here is not a harmless
// slow test either: vitest rejects the test promise but does not kill the child, so a lingering
// `runs prune` can wipe `.path/runs/` out from under the *next* test in the shared-`projectDir`
// block — which is how the timeout surfaced as a bogus "no run found" on the orphan-`rm` case.
// 30s gives real headroom over cold start; these are the slowest, most I/O-bound tests in the repo.
vi.setConfig({ testTimeout: 30_000 });

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

  it("logs the run to both run.log (with the header line) and the db log table, matching by seq (ticket #19)", async () => {
    await runCli(["run", join(projectDir, "workflow.json")], projectDir);

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const rootRunId = (db.prepare("SELECT DISTINCT root_run_id FROM log_events").get() as { root_run_id: string })
      .root_run_id;
    const dbSeqs = (db.prepare("SELECT seq FROM log_events WHERE root_run_id = ? ORDER BY seq").all(rootRunId) as {
      seq: number;
    }[]).map((r) => r.seq);
    db.close();

    const logLines = readFileSync(join(projectDir, ".path", "runs", rootRunId, "run.log"), "utf8")
      .trimEnd()
      .split("\n");
    expect(JSON.parse(logLines[0]!)).toEqual({ type: "log-header", format: "path/log@0", run_id: rootRunId });

    const fileSeqs = logLines.slice(1).map((line) => JSON.parse(line).seq);
    expect(fileSeqs).toEqual(dbSeqs);
    expect(dbSeqs.length).toBeGreaterThanOrEqual(3); // root + at least one step's started/finished
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

describe("path run --resume (ticket #177, real dev-mode process)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-resume-e2e-"));
    cpSync(join(realFixtures, "resumable.workflow.json"), join(projectDir, "workflow.json"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function originalRootRunId(): string {
    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const id = (
      db
        .prepare("SELECT root_run_id FROM runs WHERE run_id = root_run_id AND resumed_from_root_run_id IS NULL LIMIT 1")
        .get() as { root_run_id: string }
    ).root_run_id;
    db.close();
    return id;
  }

  it("resumes a real failed run end to end, reusing the succeeded step and printing the successor id", async () => {
    // The first run fails at step-b (config mode defaults to "fail"); step-a has already succeeded.
    await expect(runCli(["run", join(projectDir, "workflow.json")], projectDir)).rejects.toMatchObject({ code: 1 });
    const originalRoot = originalRootRunId();

    // Resume with a corrected config: --set feeds every rerun, so step-b now passes.
    const { stdout } = await runCli(
      ["run", join(projectDir, "workflow.json"), "--resume", originalRoot, "--set", "mode=ok"],
      projectDir,
    );
    const successorRoot = stdout.trim();
    expect(successorRoot).not.toBe(originalRoot);

    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    try {
      // step-a was reused — no run row of its own in the successor tree; step-b reran and succeeded.
      const successorRows = db
        .prepare("SELECT node_name, status FROM runs WHERE root_run_id = ?")
        .all(successorRoot) as { node_name: string | null; status: string }[];
      expect(successorRows.some((r) => r.node_name === "step-a")).toBe(false);
      expect(successorRows.find((r) => r.node_name === "step-b")?.status).toBe("succeeded");

      const successorRootRow = db
        .prepare("SELECT status, resumed_from_root_run_id FROM runs WHERE run_id = ?")
        .get(successorRoot) as { status: string; resumed_from_root_run_id: string | null };
      expect(successorRootRow.status).toBe("succeeded");
      expect(successorRootRow.resumed_from_root_run_id).toBe(originalRoot);

      // The original tree is untouched by the resume: its rows still read as the failed run left them.
      const originalRows = db
        .prepare("SELECT node_name, status FROM runs WHERE root_run_id = ?")
        .all(originalRoot) as { node_name: string | null; status: string }[];
      expect(originalRows.find((r) => r.node_name === "step-a")?.status).toBe("succeeded");
      expect(originalRows.find((r) => r.node_name === "step-b")?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  it("exits 1 with a clear error when --resume names an unknown root run id", async () => {
    await expect(
      runCli(["run", join(projectDir, "workflow.json"), "--resume", "no-such-root"], projectDir),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("no run found"),
    });
  });

  it("exits 2 when --context is combined with --resume", async () => {
    await expect(
      runCli(["run", join(projectDir, "workflow.json"), "--resume", "whatever", "--set-context", "k=v"], projectDir),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/--set-context|--context/),
    });
  });
});

describe("path run — secret masking at the persistence boundary (ticket #20, real dev-mode process)", () => {
  let projectDir: string;
  const SECRET = "super-secret-value-DEADBEEF";

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "path-engine-secret-e2e-"));
    // A step whose interpolated secret reaches argv (the real process), then flows into stdout
    // (its output), stderr, publish/context, and the workflow output map — every persisted surface.
    const workflow = stampGuids({
      format: "path/workflow@2",
      name: "secret-flow",
      worker: { type: "engine" },
      config: { apiKey: { $secret: SECRET } },
      body: [
        {
          type: "binary",
          id: "leak",
          command: "node",
          args: ["-e", "process.stdout.write(process.argv[1]);process.stderr.write('E'+process.argv[1])", "${config.apiKey}"],
          publish: { saved: "${output}" },
        },
      ],
      output: { result: "${context.saved}" },
    });
    writeFileSync(join(projectDir, "workflow.json"), JSON.stringify(workflow));
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readAllFiles(dir: string): string {
    let out = "";
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      out += entry.isDirectory() ? readAllFiles(full) : readFileSync(full, "utf8");
    }
    return out;
  }

  it("never writes the real secret to any file under .path/ or any db row, but the process gets it", async () => {
    // The spawned process received the real value: the step's stdout (the workflow output) is real.
    const { stdout } = await runCli(["run", join(projectDir, "workflow.json")], projectDir);
    expect(stdout.trim()).toBe(JSON.stringify({ result: SECRET }));

    // Not a single byte of the real secret survives under .path/ (blobs, run.log, and — since the
    // .db file itself lives there — the db). The token stands in for it everywhere.
    const pathDump = readAllFiles(join(projectDir, ".path"));
    expect(pathDump).not.toContain(SECRET);
    expect(pathDump).toContain("[secret:apiKey]");

    // And explicitly across queryable db columns (output blobs are refs, but log-event rows and
    // captured values are stored inline).
    const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
    const logRows = db.prepare("SELECT * FROM log_events").all() as Record<string, unknown>[];
    db.close();
    expect(JSON.stringify(logRows)).not.toContain(SECRET);
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
      node_name: string | null;
      status: string;
    }[];
    db.close();

    expect(rows.every((r) => r.status === "succeeded")).toBe(true);

    // The run tree: root workflow-run -> child workflow-run ("child-step") -> leaf binary ("shout").
    const root = rows.find((r) => r.parent_run_id === null);
    expect(root).toBeTruthy();
    expect(root!.node_id).toBeNull();
    expect(root!.run_id).toBe(root!.root_run_id);

    const childRun = rows.find((r) => r.node_name === "child-step");
    expect(childRun).toBeTruthy();
    expect(childRun!.parent_run_id).toBe(root!.run_id);
    expect(childRun!.root_run_id).toBe(root!.run_id);

    const leafRun = rows.find((r) => r.node_name === "shout");
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
