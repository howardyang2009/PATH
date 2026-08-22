import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/cli.js";
import { loadWorkflowTree } from "../../src/load-workflow-tree.js";
import { openProject } from "../../src/project.js";
import type { Observation, RunObserver } from "../../src/run-observer.js";

/**
 * The synthetic `do-not-wait` acceptance workflow (issue #216, spec `docs/spec/do-not-wait-join.md`
 * §9): the checked-in `docs/acceptance-workflow/do-not-wait-probe.workflow.json` running through the
 * real `path run`, not a fixture rewrite of it. Why the case is synthetic — no motivating workflow
 * exists yet, it exercises the mechanism rather than relieving a real pain (spec §1) — is in its
 * neighbour `do-not-wait-probe.NOTES.md`, the same way `release-notes.test.ts` and
 * `env-secret.test.ts` defer to their NOTES files.
 *
 * The workflow is one detached branch (`notify` → `post-signal`) that appends a line to a signal
 * file — the side effect a real branch would post to Slack — then holds for `branch_delay_ms` and
 * exits `branch_exit_code`, followed by a main-path `after` step that echoes the block's `{}` output.
 * Everything here is the real engine, db, blob tree, and both log backends; the branch is a `binary`
 * step, so unlike release-notes there is not even a scripted LLM in the way.
 *
 * The five things it pins, one per spec section:
 *   - launch-and-continue (§2): `after` finishes before the held branch, seeing `{}`.
 *   - the enclosing-run barrier (§2/§1.1): the branch is terminal before the root run returns.
 *   - `publish` rejection at load (§4): a publish injected into the branch is a load error.
 *   - failure isolation (§5, ADR 0008): a `failed` branch leaves the run `succeeded`.
 *   - resume re-fire (§7, ADR 0009): a branch left non-`succeeded` re-fires, double-firing its effect.
 */

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const acceptanceDir = join(dirname(dirname(packageRoot)), "docs", "acceptance-workflow");
const WORKFLOW_FILE = "do-not-wait-probe.workflow.json";
// Must match the workflow's `config.signal_file` default — no test overrides it via `--set`, so
// `firedCount()` reads this exact path; changing the JSON default without this would read a missing
// file and pass for the wrong reason (0 fires).
const SIGNAL_FILE = "signal.log";

interface Harness {
  projectDir: string;
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

let harness: Harness;

/** A throwaway project holding just the probe workflow — `.path/` is created beside it. */
function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "path-do-not-wait-acceptance-"));
  cpSync(join(acceptanceDir, WORKFLOW_FILE), join(dir, WORKFLOW_FILE));
  return dir;
}

beforeEach(() => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  harness = {
    projectDir: createProject(),
    stdout,
    stderr,
    io: { log: (m) => stdout.push(m), error: (m) => stderr.push(m) },
  };
});

afterEach(() => {
  rmSync(harness.projectDir, { recursive: true, force: true });
});

/** The real `path run`, with no worker substituted — the branch and main path are both `binary`. */
function runProbe(extraArgs: string[] = []): Promise<number> {
  return main(["run", join(harness.projectDir, WORKFLOW_FILE), ...extraArgs], harness.io, {});
}

/** Where the detached branch appends its "fired" line — one line per fire, so double-firing shows. */
function signalPath(): string {
  return join(harness.projectDir, SIGNAL_FILE);
}

/** The count of "fired" lines the detached branch has written — 0 if it never ran. */
function firedCount(): number {
  if (!existsSync(signalPath())) return 0;
  return readFileSync(signalPath(), "utf8").split("\n").filter((line) => line === "fired").length;
}

interface RunRow {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_name: string | null;
  status: string;
  resumed_from_root_run_id: string | null;
  reused_from_run_id: string | null;
}

function readRuns(): RunRow[] {
  const db = new Database(join(harness.projectDir, ".path", "path.db"), { readonly: true });
  try {
    return db
      .prepare(
        "SELECT run_id, root_run_id, parent_run_id, node_name, status, resumed_from_root_run_id, reused_from_run_id FROM runs",
      )
      .all() as RunRow[];
  } finally {
    db.close();
  }
}

function rowFor(nodeName: string, rootRunId?: string): RunRow {
  const rows = readRuns().filter((row) => row.node_name === nodeName && (rootRunId === undefined || row.root_run_id === rootRunId));
  return rows[0]!;
}

function rootRow(rootRunId?: string): RunRow {
  return readRuns().find((row) => row.parent_run_id === null && (rootRunId === undefined || row.root_run_id === rootRunId))!;
}

describe("acceptance: do-not-wait launch-and-continue + barrier (issue #216, spec §2)", () => {
  it("runs green — the main path sees the block's {} output and the detached branch fires", async () => {
    const code = await runProbe(["--set", "branch_delay_ms=80"]);

    expect(harness.stderr).toEqual([]);
    expect(code).toBe(0);
    // The successor's default input is the block's output; it echoes stdin, so its stdout — and the
    // workflow's printed output — is exactly the `{}` the block handed downstream (§2, §3).
    expect(JSON.parse(harness.stdout.join("\n"))).toEqual({ seen: "{}" });
    // The side effect happened exactly once: the detached branch posted its one signal.
    expect(firedCount()).toBe(1);
  });

  it("does not wait for the branch at the join, but does at the enclosing-run barrier", async () => {
    // The branch holds 200ms, the main path is instant. Launch-and-continue means `after` finishes
    // first; the barrier means the branch is `succeeded` before the root run returns (§2/§1.1).
    await expect(runProbe(["--set", "branch_delay_ms=200"])).resolves.toBe(0);

    const rows = readRuns();
    // Both step runs are on the record, and both `succeeded` — the barrier held the run open until
    // the detached branch reached a terminal status rather than returning with it still live.
    expect(rowFor("after").status).toBe("succeeded");
    expect(rowFor("post-signal").status).toBe("succeeded");
    // Every row shares one root run: strict nesting, the branch is not detached from the tree (§1.1).
    const root = rootRow();
    expect(rows.every((row) => row.root_run_id === root.run_id)).toBe(true);
    expect(root.status).toBe("succeeded");
    expect(firedCount()).toBe(1);
  });
});

describe("acceptance: do-not-wait publish rejection at load (issue #216, spec §4)", () => {
  it("rejects the checked-in workflow the moment a publish is injected into its detached branch", () => {
    // Start from the real file and add the one thing §4 forbids — a `publish` inside the branch — so
    // the rejection is pinned against the shipped workflow, not a hand-built lookalike.
    // `@2`: a branch *is* a node, so the forbidden `publish` goes directly on the branch node (§4.3).
    const file = JSON.parse(readFileSync(join(acceptanceDir, WORKFLOW_FILE), "utf8")) as {
      body: { branches?: { publish?: unknown }[] }[];
    };
    file.body[0]!.branches![0]!.publish = { echoed: "${output}" };
    const injected = join(harness.projectDir, "with-publish.workflow.json");
    writeFileSync(injected, JSON.stringify(file));

    // Load-time, whole-tree, before any step runs — the same surface `path run` loads through.
    const loaded = loadWorkflowTree(injected);
    expect(loaded.success).toBe(false);
    if (!loaded.success) {
      expect(loaded.errors.join("\n")).toMatch(/do-not-wait/);
    }
  });
});

describe("acceptance: do-not-wait failure isolation (issue #216, spec §5, ADR 0008)", () => {
  it("a failed detached branch leaves the run succeeded — the branch row is failed, the root is not", async () => {
    // The branch exits non-zero after firing its side effect; the main path succeeds. The block
    // discharged at the join, so the run ends on its main path alone — `succeeded` — with the
    // branch's `failed` recorded on its own run row (auditable, not hidden).
    const code = await runProbe(["--set", "branch_exit_code=7"]);

    expect(code).toBe(0);
    // The side effect still happened — isolation is about propagation, not suppression.
    expect(firedCount()).toBe(1);

    expect(rowFor("post-signal").status).toBe("failed");
    expect(rowFor("after").status).toBe("succeeded");
    // A run may end `succeeded` with a `failed` do-not-wait descendant in its subtree (the ADR 0008
    // invariant break, confined to this join).
    expect(rootRow().status).toBe("succeeded");
  });
});

/**
 * Runs the probe through the engine's own assembly (`openProject` + `Project.run`, the pieces `path
 * run` composes) and lands a cancellation with the detached branch still in flight: an appended
 * observer fires the operator's `AbortController` the instant the main-path `after` step finishes —
 * by then the branch has fired its side effect and is holding on `branch_delay_ms`, so the abort
 * catches it live. This mirrors `release-notes.test.ts`'s `killMidFirstRevise`: a real operator
 * cancel driven deterministically off an observation, without the process-signal plumbing an
 * in-process test cannot use. The branch ends non-`succeeded` (cancelled), which is the `--resume`
 * target's precondition.
 */
async function killWithBranchInFlight(): Promise<string> {
  const controller = new AbortController();
  // `step-finished` carries no `nodeName` (run-observer.ts) — only a `runId`. So the main-path step's
  // run id is captured off its `step-started`, and the abort fires when *that* run finishes.
  let afterRunId: string | undefined;
  const abortOnAfterFinished: RunObserver = {
    observe(o: Observation) {
      if (o.type === "step-started" && o.nodeName === "after") afterRunId = o.runId;
      if (o.type === "step-finished" && o.runId === afterRunId) controller.abort();
    },
  };

  const loaded = loadWorkflowTree(join(harness.projectDir, WORKFLOW_FILE));
  if (!loaded.success) throw new Error(loaded.errors.join("\n"));
  const rootFile = loaded.workflow.rootFile;
  const opened = openProject(harness.projectDir);
  if (!opened.success) throw new Error(opened.error);
  try {
    const result = await opened.project.run(rootFile, harness.projectDir, {
      // A hold long enough that the branch is still live when the instant `after` finishes and the
      // abort lands, but short enough that the resumed run's barrier (which re-runs the branch under
      // this same restored config) finishes well inside the test timeout.
      operatorConfig: { branch_delay_ms: "1500" },
      files: loaded.workflow.files,
      signal: controller.signal,
      extraObservers: [abortOnAfterFinished],
    });
    // The main path had already succeeded when the abort landed, so the operator cancel reaches only
    // the still-live detached branch: it ends `cancelled` (cause `operator`, §6) while the root run
    // reports `succeeded` on its main path. Either way the branch is left non-`succeeded`, which is
    // the resume precondition the re-fire test needs.
    expect(result.status).toBe("succeeded");
  } finally {
    opened.project.close();
  }

  return readRuns().find((row) => row.parent_run_id === null)!.run_id;
}

/**
 * Resume re-fire (issue #216, spec §7, ADR 0009). The predecessor is killed with the detached branch
 * in flight — it fired once, then was cancelled before reaching `succeeded`. On resume the branch is
 * ordinary unfinished work to a cause-blind resume, so it re-runs and fires *again*: at-least-once,
 * with no `do-not-wait` short-circuit (the deliberate divergence from `wait-one`'s ADR 0004). The
 * double-fire is the point — the side-effect count going from 1 to 2 is the observable proof.
 */
describe("acceptance: do-not-wait resume re-fires the detached branch (issue #216, spec §7, ADR 0009)", () => {
  it("re-fires a branch left non-succeeded, double-firing its side effect", async () => {
    const killedRootRunId = await killWithBranchInFlight();
    // The predecessor fired exactly once before the cancel caught the held branch.
    expect(firedCount()).toBe(1);
    expect(rowFor("post-signal", killedRootRunId).status).toBe("cancelled");
    expect(rowFor("after", killedRootRunId).status).toBe("succeeded");

    // Resume through the real CLI. Config restores from the killed run, so no `--set` is needed; the
    // restored 1.5s hold makes the resumed run wait at its barrier, then finish.
    const code = await main(
      ["run", join(harness.projectDir, WORKFLOW_FILE), "--resume", killedRootRunId],
      harness.io,
      {},
    );

    expect(code).toBe(0);
    expect(harness.stderr).toEqual([]);

    // The successor is a fresh tree linked back to the killed one (#177), and it completed.
    const successorRootRunId = harness.stdout.join("\n").trim().split("\n").at(-1)!;
    expect(successorRootRunId).not.toBe(killedRootRunId);
    expect(rootRow(successorRootRunId).status).toBe("succeeded");
    expect(rootRow(successorRootRunId).resumed_from_root_run_id).toBe(killedRootRunId);

    // The re-fire: `after` succeeded before the kill so it reuses — now recorded as a reuse row (#257)
    // carrying a `reused_from_run_id` pointer rather than re-executing — while the non-`succeeded`
    // branch re-runs, so the side effect fired a *second* time.
    const successorRows = readRuns().filter((row) => row.root_run_id === successorRootRunId);
    expect(successorRows.some((row) => row.node_name === "post-signal" && row.status === "succeeded")).toBe(true);
    const afterRow = successorRows.find((row) => row.node_name === "after")!;
    expect(afterRow.status).toBe("succeeded");
    expect(afterRow.reused_from_run_id).not.toBeNull();
    expect(firedCount()).toBe(2);
  }, 20000);
});
