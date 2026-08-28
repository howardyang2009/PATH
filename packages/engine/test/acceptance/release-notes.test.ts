import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/cli.js";
import { loadWorkflowTree } from "../../src/load-workflow-tree.js";
import { openProject } from "../../src/project.js";
import {
  createScriptedLlmWorker,
  SCRIPTED_COST_USD,
  SCRIPTED_USAGE,
  type ScriptedHandler,
  type ScriptedLlmWorker,
} from "./scripted-llm-worker.js";

/**
 * The MVP's definition of done (mvp spec §11, ticket #26): the real release-notes pipeline —
 * the checked-in `docs/acceptance-workflow/*.json`, not a fixture rewrite of them — running
 * end-to-end through `path run` against a real git repo.
 *
 * Everything here is the real thing except the LLM processor: the engine, both workflow files,
 * git, the sqlite db, the blob tree and both log backends. The Agent SDK worker is scripted
 * (see ./scripted-llm-worker.ts) so the pipeline is deterministic and free to run in CI; the
 * seam it plugs into is the same `llmWorker` option the CLI leaves open.
 */

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const acceptanceDir = join(dirname(dirname(packageRoot)), "docs", "acceptance-workflow");

const FEATURES_SUMMARY = "- Adds while-do loops\n- Adds parallel collect joins";
const FIXES_SUMMARY = "- Fixes secret masking at the persistence boundary";
const DRAFT = "# Release notes\n\nA draft assembled from the summaries.";
const REVISED_DRAFT = "# Release notes\n\nA revised draft that addresses the feedback.";
const FINAL_NOTES = "# Release notes\n\n- Condensed to the ten things that matter.";

function verdict(pass: boolean, format: "short" | "long" = "short"): string {
  return JSON.stringify({ pass, feedback: pass ? "Looks good." : "Be specific about the fixes.", suggested_format: format });
}

/**
 * The happy-path script: the first judge rejects the draft so the `revise-loop` genuinely runs a
 * nested `revise-cycle` workflow-run, and the judge inside that cycle passes so the loop exits
 * before `max_revisions`. `suggested_format: "short"` selects the first `pick-format` arm.
 */
function happyPathScript(): Record<string, ScriptedHandler> {
  return {
    "summarize-features": () => FEATURES_SUMMARY,
    "summarize-fixes": () => FIXES_SUMMARY,
    "draft-notes": () => DRAFT,
    "judge-draft": () => verdict(false),
    revise: () => REVISED_DRAFT,
    judge: () => verdict(true),
    "format-short": () => FINAL_NOTES,
    "format-long": () => "unexpected: the long arm should not run",
  };
}

interface Harness {
  projectDir: string;
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

let harness: Harness;

/** A throwaway git repo with the two real workflow files copied in beside its commits. */
function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "path-acceptance-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "acceptance@example.test");
  git("config", "user.name", "Acceptance Test");
  git("config", "commit.gpgsign", "false");

  for (const [n, subject] of ["feat: add while-do loops", "fix: mask secrets", "feat: collect joins", "chore: tidy"].entries()) {
    writeFileSync(join(dir, `file-${n}.txt`), `contents ${n}\n`);
    git("add", ".");
    git("commit", "--quiet", "-m", subject);
  }

  cpSync(join(acceptanceDir, "release-notes.workflow.json"), join(dir, "release-notes.workflow.json"));
  cpSync(join(acceptanceDir, "revise-cycle.workflow.json"), join(dir, "revise-cycle.workflow.json"));
  return dir;
}

beforeEach(() => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  harness = {
    projectDir: createRepo(),
    stdout,
    stderr,
    io: { log: (m) => stdout.push(m), error: (m) => stderr.push(m) },
  };
});

afterEach(() => {
  rmSync(harness.projectDir, { recursive: true, force: true });
});

/** Runs the real `path run` command, substituting only the LLM worker. */
function runPipeline(
  worker: ScriptedLlmWorker,
  extraArgs: string[] = [],
  commitRange = "HEAD~3..HEAD",
): Promise<number> {
  return main(
    [
      "run",
      join(harness.projectDir, "release-notes.workflow.json"),
      "--set",
      `commit_range=${commitRange}`,
      ...extraArgs,
    ],
    harness.io,
    { llmWorker: worker },
  );
}

interface RunRow {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  node_name: string | null;
  // Nullable: the root workflow-run is inserted without a worker (persisted-observer.ts).
  worker: string | null;
  status: string;
  input_ref: string | null;
  output_ref: string | null;
  usage: string | null;
  estimated_cost_usd: number | null;
  // A successor run's root row links back to the tree it resumed (#177); null on a fresh run.
  resumed_from_root_run_id: string | null;
}

function readRuns(projectDir: string): RunRow[] {
  const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
  try {
    return db.prepare("SELECT * FROM runs").all() as RunRow[];
  } finally {
    db.close();
  }
}

/**
 * Splits the run tree into workflow-runs and leaf step runs.
 *
 * Node ids are unique per *file*, not per tree, and the real pipeline leans on that: `revise` is
 * both the `workflow` step in release-notes and the first `prompt` step inside revise-cycle. So
 * rows are classified structurally — a workflow-run is the root or any row some other row calls
 * its parent — rather than by node id, which would conflate the two.
 */
function classifyRuns(runs: RunRow[]): { root: RunRow; workflowRuns: RunRow[]; leaves: RunRow[] } {
  const parentIds = new Set(runs.map((row) => row.parent_run_id).filter((id): id is string => id !== null));
  const root = runs.find((row) => row.parent_run_id === null)!;
  return {
    root,
    workflowRuns: runs.filter((row) => parentIds.has(row.run_id)),
    leaves: runs.filter((row) => !parentIds.has(row.run_id)),
  };
}

function isLlmRun(row: RunRow): boolean {
  return row.worker !== null && (JSON.parse(row.worker) as { type: string }).type === "llm";
}

function readDbLogEvents(projectDir: string, rootRunId: string): { seq: number; type: string }[] {
  const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT seq, type FROM log_events WHERE root_run_id = ? ORDER BY seq")
      .all(rootRunId) as { seq: number; type: string }[];
  } finally {
    db.close();
  }
}

function readRunLog(projectDir: string, rootRunId: string): { seq: number; type: string }[] {
  const lines = readFileSync(join(projectDir, ".path", "runs", rootRunId, "run.log"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  // The first line is the NDJSON header (#19), not an event.
  return lines
    .map((line) => JSON.parse(line) as { seq?: number; type?: string })
    .filter((entry): entry is { seq: number; type: string } => entry.seq !== undefined && entry.type !== undefined)
    .map(({ seq, type }) => ({ seq, type })); // projected to match the db-side selection
}

describe("acceptance: release-notes pipeline end-to-end (mvp spec §11, ticket #26)", () => {
  it("criterion 1 — produces RELEASE_NOTES.md for a real commit range", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());

    const code = await runPipeline(worker);

    expect(harness.stderr).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(harness.projectDir, "RELEASE_NOTES.md"), "utf8")).toBe(FINAL_NOTES);
    // The workflow's own `output` map (format doc §6.4) is what the CLI prints.
    expect(JSON.parse(harness.stdout.join("\n"))).toEqual({ file: "RELEASE_NOTES.md" });
  });

  it("criterion 1 — exercises every construct in the coverage map, in order", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());

    await expect(runPipeline(worker)).resolves.toBe(0);

    // parallel branches may settle in either order; the rest of the pipeline is strictly ordered.
    const nodeIds = worker.calls.map((call) => call.nodeName);
    expect(nodeIds.slice(0, 2).sort()).toEqual(["summarize-features", "summarize-fixes"]);
    expect(nodeIds.slice(2)).toEqual(["draft-notes", "judge-draft", "revise", "judge", "format-short"]);

    // The real git history reached the first LLM step, so the binary step genuinely ran git —
    // and ran it in the *workflow's* repo (`repo_path: "."`), not wherever the test process sits.
    const summarizeInput = worker.calls[0]!.input as { raw_changes: string };
    expect(summarizeInput.raw_changes).toContain("chore: tidy");
    expect(summarizeInput.raw_changes).toContain("fix: mask secrets");
    // `HEAD~3..HEAD` excludes the first of the four commits — the range was honoured.
    expect(summarizeInput.raw_changes).not.toContain("feat: add while-do loops");

    // Nested-workflow context isolation: the cycle sees only what the input map passed it.
    const reviseInput = worker.calls[4]!.input as Record<string, unknown>;
    expect(Object.keys(reviseInput).sort()).toEqual(["draft", "feedback", "raw_changes"]);
    expect(reviseInput.feedback).toBe("Be specific about the fixes.");
    // The branch arm read the verdict published by the *nested* cycle, not the first judge.
    expect((worker.calls[6]!.input as { draft: string }).draft).toBe(REVISED_DRAFT);
  });

  it("criterion 2 — leaves a run row for every step run, mirroring the run tree", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker)).resolves.toBe(0);

    const runs = readRuns(harness.projectDir);
    const { root, workflowRuns, leaves } = classifyRuns(runs);
    expect(root.node_id).toBeNull();
    expect(runs.every((row) => row.root_run_id === root.run_id)).toBe(true);
    expect(runs.every((row) => row.status === "succeeded")).toBe(true);

    // Every leaf step that ran has its own row. Compared as a set — the parallel block's two
    // branches insert in whichever order they settle; step *ordering* is asserted separately.
    expect(leaves.map((row) => row.node_name).sort()).toEqual([
      "draft-notes",
      "format-short",
      "gather-changes",
      "judge",
      "judge-draft",
      "revise",
      "summarize-features",
      "summarize-fixes",
      "write-file",
    ]);
    // Checkpoints are logic, not step runs — they leave no row.
    expect(runs.some((row) => row.node_name === "have-changes")).toBe(false);

    // The nested workflow-run (#22) is the root plus exactly one revise-cycle, and the cycle's
    // steps hang off it rather than off the root.
    expect(workflowRuns).toHaveLength(2);
    const cycle = workflowRuns.find((row) => row.run_id !== root.run_id)!;
    expect(cycle.node_name).toBe("revise");
    expect(cycle.parent_run_id).toBe(root.run_id);
    const cycleLeaves = leaves.filter((row) => row.parent_run_id === cycle.run_id);
    expect(cycleLeaves.map((row) => row.node_name)).toEqual(["revise", "judge"]);
  });

  it("criterion 2 — writes the log narrative to both backends, matching by seq", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker)).resolves.toBe(0);

    const rootRunId = readRuns(harness.projectDir).find((row) => row.parent_run_id === null)!.run_id;
    const fromDb = readDbLogEvents(harness.projectDir, rootRunId);
    const fromFile = readRunLog(harness.projectDir, rootRunId);

    expect(fromDb.length).toBeGreaterThan(0);
    expect(fromFile).toEqual(fromDb);
    expect(fromDb.map((event) => event.type)).toContain("step-started");
    expect(fromDb.map((event) => event.type)).toContain("step-finished");
  });

  it("criterion 2 — writes every input/output object and context.json under .path/runs/", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker)).resolves.toBe(0);

    const runs = readRuns(harness.projectDir);
    const rootRunId = runs.find((row) => row.parent_run_id === null)!.run_id;
    const treeDir = join(harness.projectDir, ".path", "runs", rootRunId);

    for (const row of runs) {
      const runDir = join(treeDir, row.run_id);
      expect(existsSync(join(runDir, "input.json")), `no input.json for "${row.node_id}"`).toBe(true);
      expect(existsSync(join(runDir, "output.json")), `no output.json for "${row.node_id}"`).toBe(true);
      expect(row.input_ref).toBe(`runs/${rootRunId}/${row.run_id}/input.json`);
      expect(row.output_ref).toBe(`runs/${rootRunId}/${row.run_id}/output.json`);
    }

    // Each workflow-run has its own context.json blackboard — the root's and the nested cycle's.
    const { workflowRuns } = classifyRuns(runs);
    expect(workflowRuns).toHaveLength(2);
    for (const row of workflowRuns) {
      expect(existsSync(join(treeDir, row.run_id, "context.json")), `no context.json for run ${row.run_id}`).toBe(true);
    }

    const rootContext = JSON.parse(readFileSync(join(treeDir, rootRunId, "context.json"), "utf8"));
    expect(rootContext).toMatchObject({ draft: REVISED_DRAFT, final_notes: FINAL_NOTES, file: "RELEASE_NOTES.md" });
  });

  it("criterion 4 — records usage and estimated_cost_usd on every LLM run, and only those", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker)).resolves.toBe(0);

    const runs = readRuns(harness.projectDir);
    const { workflowRuns, leaves } = classifyRuns(runs);

    // Every prompt step run — all seven of them — carries what it spent (mvp spec §5.7).
    const llmLeaves = leaves.filter(isLlmRun);
    expect(llmLeaves).toHaveLength(7);
    for (const row of llmLeaves) {
      expect(JSON.parse(row.usage!), `usage missing on "${row.node_id}"`).toEqual(SCRIPTED_USAGE);
      expect(row.estimated_cost_usd, `cost missing on "${row.node_id}"`).toBeCloseTo(SCRIPTED_COST_USD);
    }

    // Spend is recorded leaf-only: binary steps never spend, and a workflow-run stores no total of
    // its children's spend — subtree figures are a read-time SUM (mvp spec §5.7).
    for (const row of [...workflowRuns, ...leaves.filter((leaf) => !isLlmRun(leaf))]) {
      expect(row.usage, `unexpected usage on "${row.node_id}"`).toBeNull();
      expect(row.estimated_cost_usd, `unexpected cost on "${row.node_id}"`).toBeNull();
    }
  });

  it("criterion 1 — picks the long branch arm when the verdict asks for it", async () => {
    // The happy path always takes the `short` arm; `pick-format` is ordered-arms/first-match-wins
    // (NOTES.md), so the second arm needs its own run to be exercised at all.
    const worker = createScriptedLlmWorker({
      ...happyPathScript(),
      "judge-draft": () => verdict(true, "long"),
      "format-long": () => "# Release notes\n\n## Features\n\nThe long form.",
    });

    await expect(runPipeline(worker)).resolves.toBe(0);

    const nodeIds = worker.calls.map((call) => call.nodeName);
    expect(nodeIds).toContain("format-long");
    expect(nodeIds).not.toContain("format-short");
    // A passing first verdict also means the while-do loop never entered.
    expect(nodeIds).not.toContain("revise");
    expect(readFileSync(join(harness.projectDir, "RELEASE_NOTES.md"), "utf8")).toContain("## Features");
  });

  it("criterion 4 — fans out the parallel block when the cap leaves room", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker)).resolves.toBe(0);
    // The `summarize` block's two branches are the pipeline's only concurrency, and the default cap
    // of 4 leaves room for both. This shows fan-out *happens* — on its own it says nothing about
    // the cap (2 < 4 would hold with the semaphore removed); the next test is what binds it.
    expect(worker.maxConcurrent).toBe(2);
  });

  it("criterion 4 — respects the Processor fan-out cap when it binds", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());
    await expect(runPipeline(worker, ["--processor-concurrency", "1"])).resolves.toBe(0);
    // Same block, cap lowered below its width: it serialises instead of fanning out. Removing the
    // semaphore fails this assertion, which is what makes it a test of the cap.
    expect(worker.maxConcurrent).toBe(1);
  });
});

describe("acceptance: failure paths (mvp spec §11 criterion 3)", () => {
  it("an empty commit range trips the have-changes checkpoint", async () => {
    const worker = createScriptedLlmWorker(happyPathScript());

    const code = await runPipeline(worker, [], "HEAD..HEAD");

    expect(code).toBe(1);
    expect(harness.stderr.join("\n")).toContain("have-changes");
    // Fail-fast: the checkpoint stopped the run before any LLM processor was spawned.
    expect(worker.calls).toEqual([]);
    expect(existsSync(join(harness.projectDir, "RELEASE_NOTES.md"))).toBe(false);

    const runs = readRuns(harness.projectDir);
    expect(runs.find((row) => row.parent_run_id === null)!.status).toBe("failed");
    // The audit trail survives a failed run: the step that did run is still recorded.
    expect(runs.find((row) => row.node_name === "gather-changes")!.status).toBe("succeeded");
  });

  it("a never-passing judge exhausts max_revisions and fails the run", async () => {
    const worker = createScriptedLlmWorker({
      ...happyPathScript(),
      "judge-draft": () => verdict(false),
      judge: () => verdict(false), // never passes, so the loop condition stays true
    });

    const code = await runPipeline(worker, ["--set", "max_revisions=2"]);

    expect(code).toBe(1);
    expect(harness.stderr.join("\n")).toContain("revise-loop");
    expect(existsSync(join(harness.projectDir, "RELEASE_NOTES.md"))).toBe(false);

    // The loop ran exactly max_revisions cycles before giving up.
    expect(worker.calls.filter((call) => call.nodeName === "revise")).toHaveLength(2);

    const runs = readRuns(harness.projectDir);
    const { root, workflowRuns, leaves } = classifyRuns(runs);
    expect(root.status).toBe("failed");
    // Both cycles are on the record as their own workflow-runs...
    expect(workflowRuns.filter((row) => row.run_id !== root.run_id)).toHaveLength(2);
    // ...and the spend of a run that ultimately failed is still accounted for.
    expect(leaves.filter(isLlmRun).every((row) => row.usage !== null)).toBe(true);
  });
});

/** The reuse-markers (#172) a resumed root run wrote, read straight from the `db` log backend. */
function readReuseMarkers(projectDir: string, rootRunId: string): { nodeName: string; originalRunId: string }[] {
  const db = new Database(join(projectDir, ".path", "path.db"), { readonly: true });
  try {
    const rows = db
      .prepare("SELECT event FROM log_events WHERE root_run_id = ? AND type = 'reuse-marker' ORDER BY seq")
      .all(rootRunId) as { event: string }[];
    return rows.map((row) => {
      const event = JSON.parse(row.event) as { node_name: string; original_run_id: string };
      return { nodeName: event.node_name, originalRunId: event.original_run_id };
    });
  } finally {
    db.close();
  }
}

/**
 * Runs the real pipeline through the engine's own assembly (`openProject` + `Project.run` — the very
 * pieces `path run` composes under the hood) and lands a genuine cancellation one `while-do`
 * iteration in: an `AbortController`, the operator's own `RunOptions.signal` (mvp spec §5.6), fires
 * the instant the first `revise` prompt is in flight, so the run unwinds to `cancelled` exactly as a
 * `^C` would. This mirrors #144's kill methodology — a SIGINT delivered deep in the LLM stretch —
 * driving the same cancellation path without the process-signal plumbing a deterministic in-process
 * acceptance run cannot use (a real SIGINT would take vitest itself down). Returns the killed run's
 * root id — the `--resume` target — and its worker, for the re-burn assertion.
 */
async function killMidFirstRevise(): Promise<{ rootRunId: string; worker: ScriptedLlmWorker }> {
  const controller = new AbortController();
  const worker = createScriptedLlmWorker(happyPathScript(), {
    onCall: ({ nodeName, callNumber }) => {
      // The first `revise` prompt runs inside the while-do's first nested revise-cycle — killing here
      // is a kill mid-iteration, after the pre-loop work (summaries, draft, judge-draft) succeeded.
      if (nodeName === "revise" && callNumber === 1) controller.abort();
    },
  });

  const loaded = loadWorkflowTree(join(harness.projectDir, "release-notes.workflow.json"));
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const rootFile = loaded.workflow.rootFile;
  const opened = openProject(harness.projectDir);
  if (!opened.success) throw new Error(opened.error);
  try {
    const result = await opened.project.run(rootFile, harness.projectDir, {
      operatorConfig: { commit_range: "HEAD~3..HEAD" },
      files: loaded.workflow.files,
      llmWorker: worker,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  } finally {
    opened.project.close();
  }

  const rootRunId = readRuns(harness.projectDir).find((row) => row.parent_run_id === null)!.run_id;
  return { rootRunId, worker };
}

/**
 * #178: the acceptance pipeline killed mid-`while-do` and resumed. The kill (above) mirrors #144's
 * methodology against the real pipeline; the resume drives the real `path run --resume` surface
 * (#177). The contract under test is resume's whole point — the successor completes, and every node
 * whose work already landed is reused rather than re-billed.
 */
describe("acceptance: resume after a mid-while-do kill (#178)", () => {
  // Pre-loop nodes that succeeded before the kill: everything up to and including judge-draft. On
  // resume these must reuse — no fresh execution, no fresh spend.
  const REUSED_NODES = ["gather-changes", "summarize-features", "summarize-fixes", "draft-notes", "judge-draft"];

  it("completes on --resume, reusing pre-loop nodes instead of re-running them", async () => {
    const { rootRunId: killedRootRunId } = await killMidFirstRevise();
    // The killed run left no output file — it stopped inside the loop, before write-file.
    expect(existsSync(join(harness.projectDir, "RELEASE_NOTES.md"))).toBe(false);

    // Resume through the real CLI. A fresh worker, so its `calls` count only what the successor ran.
    const resumeWorker = createScriptedLlmWorker(happyPathScript());
    const code = await main(
      ["run", join(harness.projectDir, "release-notes.workflow.json"), "--resume", killedRootRunId],
      harness.io,
      { llmWorker: resumeWorker },
    );

    expect(code).toBe(0);
    expect(harness.stderr).toEqual([]);
    // The successor completed the pipeline the kill interrupted: the file is written, from a draft
    // that went once through the loop the resumed run re-ran.
    expect(readFileSync(join(harness.projectDir, "RELEASE_NOTES.md"), "utf8")).toBe(FINAL_NOTES);

    // reportResume prints the successor's own fresh root run id, and only that, on success (#177).
    const successorRootRunId = harness.stdout.join("\n").trim();
    expect(successorRootRunId).not.toBe(killedRootRunId);

    // Reused nodes did not execute again: the successor's worker was asked only for the loop it
    // re-ran and the format step past it. The five pre-loop nodes are absent from its calls.
    const resumedNodeIds = resumeWorker.calls.map((call) => call.nodeName);
    expect(resumedNodeIds).toEqual(["revise", "judge", "format-short"]);
    for (const reused of REUSED_NODES) expect(resumedNodeIds).not.toContain(reused);
  });

  it("records the reuse of every succeeded pre-loop node and re-bills none of them", async () => {
    const { rootRunId: killedRootRunId } = await killMidFirstRevise();

    const resumeWorker = createScriptedLlmWorker(happyPathScript());
    await expect(
      main(
        ["run", join(harness.projectDir, "release-notes.workflow.json"), "--resume", killedRootRunId],
        harness.io,
        { llmWorker: resumeWorker },
      ),
    ).resolves.toBe(0);
    const successorRootRunId = harness.stdout.join("\n").trim();

    // Every pre-loop node reused, each with a marker back-referencing the killed tree's own run — the
    // narrative record of "not re-run" (#172). One marker per node, no more.
    const markers = readReuseMarkers(harness.projectDir, successorRootRunId);
    expect(markers.map((marker) => marker.nodeName).sort()).toEqual([...REUSED_NODES].sort());
    expect(markers.every((marker) => marker.originalRunId.length > 0)).toBe(true);

    // The successor is a successor: its root row links back to the killed run, and it is a fresh tree.
    const successorRuns = readRuns(harness.projectDir).filter((row) => row.root_run_id === successorRootRunId);
    const successorRoot = successorRuns.find((row) => row.parent_run_id === null)!;
    expect(successorRoot.resumed_from_root_run_id).toBe(killedRootRunId);

    // Not re-billed, as a number (#144's re-burn made a metric): a reused node writes no row in the
    // successor tree at all, so the only spend the successor carries is the three LLM steps it truly
    // re-ran — the loop's revise + judge, and format-short. The five reused nodes contribute nothing.
    const { leaves } = classifyRuns(successorRuns);
    const llmLeaves = leaves.filter(isLlmRun);
    expect(llmLeaves).toHaveLength(3);
    for (const reused of REUSED_NODES) {
      expect(successorRuns.some((row) => row.node_id === reused)).toBe(false);
    }
    const reburn = llmLeaves.reduce((sum, row) => sum + (row.estimated_cost_usd ?? 0), 0);
    expect(reburn).toBeCloseTo(3 * SCRIPTED_COST_USD);
  });
});
