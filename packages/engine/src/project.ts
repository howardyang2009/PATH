import { resolve } from "node:path";
import {
  childrenByParent,
  findRootRun,
  isReuseRow,
  isTerminal,
  type JsonValue,
  type RunRecord,
  type RunStatus,
  type WorkflowFile,
} from "@path/schema";
import type Database from "better-sqlite3";
import { createLogBackends, DEFAULT_LOG_BACKENDS, type LogBackendId } from "./logging/backends.js";
import type { LogBackend } from "./logging/log-backend.js";
import { createLoggingObserver } from "./logging/logging-observer.js";
import { readJsonBlob } from "./persistence/blob-store.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { ensurePathDirGitignore } from "./persistence/gitignore.js";
import { dbFilePath, pathDir, runBlobDir } from "./persistence/paths.js";
import { createPersistedObserver } from "./persistence/persisted-observer.js";
import { getRun, getRunsForRoot } from "./persistence/run-store.js";
import { resolveLegalK, type LegalKContainer, type LegalKReasonCode } from "./resume-legal-k.js";
import { createRunArchive, type RunArchive } from "./run-archive.js";
import { composeObservers, type RunObserver } from "./run-observer.js";
import { type ResumeInput, type RunOptions, type RunResult, runWorkflow } from "./run-workflow.js";
import { type EngineSettings, loadEngineSettings } from "./settings/engine-settings.js";

/**
 * A project directory, opened: the `.path/` beside a workflow, with its db and engine settings, and
 * the one way to run a workflow against it.
 *
 * **What this module exists to own (#64).** Running one workflow correctly took five modules
 * assembled in a required order, and the three callers that did it by hand disagreed. The server
 * passed the project directory where the engine wanted the workflow file's own directory (#59); it
 * never read `.path/settings.json` at all; and `composeObservers`' load-bearing argument order was
 * upheld only by two comments. All three are properties of the *assembly*, so the assembly is what
 * gets an owner.
 *
 * The division of labour is deliberate. A `Project` knows about `.path/` — where it is, what is in
 * it, how a run is recorded into it. It knows nothing about argument parsing, exit codes, HTTP
 * status, or when to stop; those stay with the CLI and the server, which is why `run` takes a plain
 * `signal` and returns a plain `RunResult`.
 */
export interface Project {
  /** The absolute project directory: where `.path/` is read and written. Never a workflow's own directory. */
  readonly dir: string;
  /**
   * What this project's runs left behind, read back: rows, blobs and narratives, over the same open
   * db `run` writes to. The db handle itself used to be public here, which is how every reader
   * ended up composing `.path/`'s layout for itself — see `run-archive.ts`.
   */
  readonly archive: RunArchive;
  /** `.path/settings.json` as loaded at open time (mvp spec §9) — `{}` when the file is absent. */
  readonly settings: EngineSettings;
  /**
   * Run one workflow against this project.
   *
   * `workflowDir` is the **root workflow file's own directory**, which is what the engine resolves
   * nested `workflow` refs and binary `cwd`s against — not `dir`. The two are equal whenever the
   * workflow sits at the project root, which is why the CLI never had to tell them apart and why
   * the server got it wrong (#59). Keeping `dir` on the `Project` and taking `workflowDir` as an
   * argument means no call site supplies both, so they can no longer be crossed.
   */
  run(rootFile: WorkflowFile, workflowDir: string, opts?: ProjectRunOptions): Promise<RunResult>;
  /**
   * Resume a prior root run (#173): re-run `rootFile` as a **successor** of the tree rooted at
   * `rootRunId`, reusing every node whose recorded run still matches (#170/#172) and restoring each
   * re-entered workflow-run's context from the original tree. The one call site the CLI (and later a
   * server route) converges on for resume's engine-side behaviour.
   *
   * The successor is an ordinary root run in every structural sense: its own fresh root run id, its
   * own `.path/runs/<new-root>/` directory, its own db rows and log backend — opened exactly as
   * `run` opens any root run. The only trace of the lineage is `resumed_from_root_run_id` on the
   * successor's root row, set to `rootRunId`. The original tree is **read-only** throughout — its
   * rows, blobs and `run.log` are byte-identical before and after.
   *
   * Returns a discriminated result and never throws on operator input: `found: false` when
   * `rootRunId` names no known root run, otherwise `found: true` carrying the successor's own root
   * run id and the run outcome. (An engine-invariant breach — a resumed run that emits no root
   * `run-started` — throws rather than masquerading as `found: false`; it is not reachable from input.)
   */
  resume(rootFile: WorkflowFile, rootRunId: string, workflowDir: string, opts?: ProjectRunOptions): Promise<ResumeResult>;
  /**
   * The `--list-eligible` dry-run of resume (#446): compute, but do not launch, the per-node eligibility
   * of the source tree rooted at `rootRunId`, evaluated against `rootFile`. Launches nothing — no
   * successor run, no store write. Returns every run of the source tree in DFS pre-order, each with the
   * `eligible?` verdict from the **same** `resolveLegalK` authority `resume` validates a single `--from`
   * against (spec §3), so the listing can never say *eligible* where `--from` would refuse.
   *
   * The whole-command gates mirror a real resume (spec §7): an unknown root run or a non-terminal source
   * refuses the whole command (`found: false`) rather than yielding a per-row verdict; `files` supplies
   * the nested-workflow tree the descent resolves refs against, exactly as `resume` receives it.
   */
  listEligible(rootFile: WorkflowFile, rootRunId: string, workflowDir: string, files?: Map<string, WorkflowFile>): ListEligibleResult;
  /** Closes the db. A `Project` outlives one run (the server holds one per process) and must be closed once. */
  close(): void;
}

/**
 * The outcome of `Project.resume` (#173) — a Result, not a throw, because "no such root run" is an
 * ordinary operator input, not an exceptional one, and the CLI (and a server route) branch on it the
 * same way they branch on a failed run.
 *
 * `found: false` is the unknown-root-run-id case alone. `found: true` carries the **successor's** own
 * fresh root run id — never the predecessor's — plus the same status/output/error a `RunResult` would,
 * so a caller prints or exits on a resumed run exactly as it does on a fresh one.
 */
export type ResumeResult =
  | { found: false; error: string }
  | { found: false; refusal: ResumeRefusal }
  | {
      found: true;
      rootRunId: string;
      status: "succeeded" | "failed" | "cancelled";
      output: JsonValue;
      error?: string;
    };

/**
 * A Resume-from-K refusal (#444, ADR 0032): the one legal-K authority (`Project.resume`) rejected the
 * operator's `rerunFromRunId` before any successor started. `status` follows the §5 taxonomy (400 =
 * unresolvable/unsupported selection, 409 = state/file-divergence conflict); `message` is the one
 * wording authority a surface renders verbatim. Distinct from `{found:false, error}`, which stays the
 * unknown-root-run case shared by plain Resume.
 */
export interface ResumeRefusal {
  status: number;
  message: string;
}

/**
 * One node's `--list-eligible` verdict (#446, spec §6): `eligible: true` when it is a legal K, else the
 * §5 taxonomy classification of *why* it is not — the same classification `resolveLegalK` attaches to a
 * `--from` refusal, so the listing can never disagree with what `--from` accepts. The reason is a code,
 * not a rendered string: the CLI owns the §6 cell wording (`inside a loop body`, …); the engine owns the
 * verdict.
 */
export type EligibilityVerdict =
  | { eligible: true }
  | { eligible: false; reason: LegalKReasonCode; container?: LegalKContainer };

/** One row of the `--list-eligible` listing (#446, spec §5): a source-tree run and its eligibility verdict. */
export interface EligibilityRow {
  runId: string;
  /** The producing node's human `name`; null for the root run (the CLI renders `-`). */
  nodeName: string | null;
  status: RunStatus;
  verdict: EligibilityVerdict;
}

/**
 * The outcome of `Project.listEligible` (#446, spec §7). The whole-command gates mirror a real resume:
 * `found: false` carries the same `no run found`/non-terminal message a resume of this root would, so
 * the CLI exits 1 with one wording; `found: true` carries every source-tree run in DFS pre-order.
 */
export type ListEligibleResult =
  | { found: false; error: string }
  | { found: true; rows: EligibilityRow[] };

/**
 * The whole-command precondition `resume` and `listEligible` share (spec §7): the source tree named by
 * `rootRunId` must exist (a known root run) and be **terminal**. `getRunsForRoot` keys on `root_run_id`,
 * so a non-root (child) id — like an unknown id — returns no rows, which is the same `not-found` case.
 * Terminality is checked on the root row: a node's status can still flip while the tree runs, so the
 * legal-K test assumes a terminal source (spec §5 precondition, ADR 0032); a non-terminal source is
 * refused whole, never a per-row verdict (spec §7). `undefined` means the precondition holds.
 *
 * The two problems differ in kind so each surface renders them right: `not-found` is the unknown-root
 * case plain Resume already had (a 404 / `no run found` on the server), while `non-terminal` is a state
 * conflict the server answers 409 with the message intact — both exit 1 on the CLI.
 */
type ResumeSourceProblem = { kind: "not-found"; message: string } | { kind: "non-terminal"; message: string };

function checkResumeSource(rows: RunRecord[], rootRunId: string): ResumeSourceProblem | undefined {
  const root = rows.find((r) => r.parentRunId === null);
  if (rows.length === 0 || !root) {
    return { kind: "not-found", message: `no run found with root run id "${rootRunId}"` };
  }
  if (!isTerminal(root.status)) {
    return { kind: "non-terminal", message: `run "${rootRunId}" is still ${root.status}; resume needs a terminal source run` };
  }
  return undefined;
}

/**
 * The source tree's runs in **tree pre-order (depth-first)** (spec §4): a node sits under its parent, so
 * the tree structure reads top-down. Built from the `parentRunId` adjacency; children keep their stored
 * order. The root always has at least its own row, so the listing is never empty.
 */
function preorderRuns(rows: RunRecord[]): RunRecord[] {
  const byParent = childrenByParent(rows);
  const root = findRootRun(rows);
  const out: RunRecord[] = [];
  const visit = (row: RunRecord): void => {
    out.push(row);
    for (const child of byParent.get(row.runId) ?? []) visit(child);
  };
  if (root) visit(root);
  return out;
}

/**
 * `RunOptions` minus the audit seam, which is the `Project`'s to compose, plus the two engine
 * settings as *overrides* and the two extension points the server needs.
 */
export interface ProjectRunOptions extends Omit<RunOptions, "observer"> {
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  logBackends?: LogBackendId[];
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  processorConcurrency?: number;
  /**
   * Backends alongside the configured ones — the server's live-forwarding backend, which pushes to
   * SSE subscribers regardless of what the run persists to.
   */
  extraBackends?: LogBackend[];
  /**
   * Resume-only (#444): the operator's **source run id** naming the rerun boundary K. `Project.resume`
   * resolves it to a top-level node-id path and enforces legal-K (spec §5) — the one authority.
   * Absent = plain Resume (K at the auto-boundary). Ignored by `run`.
   */
  rerunFromRunId?: string;
  /**
   * Observers appended **after** the built-in pair, always. The server's capture observer resolves
   * the deferred that sends its 202, and a client may `GET` the run the instant that lands — so it
   * must run after persistence has written the row and after logging has opened the hub channel.
   * That is a guarantee of this slot, not a convention a caller upholds.
   */
  extraObservers?: RunObserver[];
}

/**
 * Why a Result and not a throw: the CLI distinguishes the two failures in its exit code — a bad
 * settings file is an operator error (2), an unopenable db is not (1) — so the kind has to survive
 * the return. `test/cli.test.ts` pins both.
 */
export type OpenProjectResult =
  | { success: true; project: Project }
  | { success: false; kind: "settings" | "db"; error: string };

/**
 * Opens a project directory: ensures `.path/` exists and is self-gitignored, loads engine settings,
 * and opens the db. Ordering matters — the gitignore call creates `.path/`, so it must precede
 * opening a db file inside it.
 */
export function openProject(dir: string): OpenProjectResult {
  const absDir = resolve(dir);
  ensurePathDirGitignore(pathDir(absDir));

  // Engine-level settings (#27), strictly apart from workflow Config: read by the engine, never by
  // a step, and never merged into `${config.x}`.
  const loaded = loadEngineSettings(absDir);
  if (!loaded.success) return { success: false, kind: "settings", error: loaded.error };

  let db: Database.Database;
  try {
    db = openDb(dbFilePath(absDir));
  } catch (err) {
    const error = err instanceof SchemaVersionError ? err.message : `cannot open .path/path.db: ${String(err)}`;
    return { success: false, kind: "db", error };
  }

  const settings = loaded.settings;

  /**
   * The assembly `run` and `resume` share (#173): backend selection, the persistence-before-logging
   * observer pair, settings precedence, and the `runWorkflow` call. The only thing that varies
   * between the two is the `resume` input and any observer a caller wants appended after the built-in
   * pair — so those are the only two parameters, and everything load-bearing is spelled once.
   */
  function execute(
    rootFile: WorkflowFile,
    workflowDir: string,
    opts: ProjectRunOptions,
    resume: ResumeInput | undefined,
    appendObservers: RunObserver[],
  ): Promise<RunResult> {
    const { logBackends, processorConcurrency, extraBackends = [], extraObservers = [], ...runOptions } = opts;

    // Nearest wins, one rule for every caller: explicit override (a CLI flag, a request field)
    // beats `.path/settings.json`, which beats the built-in default.
    const backendIds = logBackends ?? settings.logBackends ?? DEFAULT_LOG_BACKENDS;
    const backends = createLogBackends(backendIds, { db, projectDir: absDir });

    // Persistence first, deliberately. A log backend write failure raises `ObserverError`, which
    // aborts the remaining observers for that observation — so with logging first, a run whose
    // audit failed would also have no run row. The row is what survives a failed audit.
    const observer = composeObservers(
      createPersistedObserver(db, absDir),
      createLoggingObserver([...backends, ...extraBackends]),
      ...extraObservers,
      ...appendObservers,
    );

    return runWorkflow(rootFile, workflowDir, {
      ...runOptions,
      observer,
      processorConcurrency: processorConcurrency ?? settings.processorConcurrency,
      resume,
    });
  }

  return {
    success: true,
    project: {
      dir: absDir,
      archive: createRunArchive(db, absDir),
      settings,
      run(rootFile: WorkflowFile, workflowDir: string, opts: ProjectRunOptions = {}): Promise<RunResult> {
        return execute(rootFile, workflowDir, opts, undefined, []);
      },
      async resume(
        rootFile: WorkflowFile,
        rootRunId: string,
        workflowDir: string,
        opts: ProjectRunOptions = {},
      ): Promise<ResumeResult> {
        // The whole original tree's rows (#170's `planReuse` input), read once. A `rootRunId` that
        // names no root run yields no rows — `getRunsForRoot` keys on `root_run_id`, so a non-root
        // (child) id returns nothing too — which is exactly the `found: false` case. The root row's
        // own presence is the second half of "known root run": a set of rows without it is not a tree
        // this can resume from.
        const directRuns = getRunsForRoot(db, rootRunId);
        const problem = checkResumeSource(directRuns, rootRunId);
        if (problem !== undefined) {
          // Unknown root stays the `error` (404 / not-found) plain Resume had; a non-terminal source is
          // a state conflict — a refusal carrying 409 and the message, so a surface answers it truthfully
          // rather than as "not found" (spec §7, §9.6). Both exit 1 on the CLI (`reportResume`).
          return problem.kind === "not-found"
            ? { found: false, error: problem.message }
            : { found: false, refusal: { status: 409, message: problem.message } };
        }

        // Resume-from-K (#444, ADR 0032): resolve the operator's source run id to the top-level rerun
        // boundary node-id path and enforce legal-K here — the one authority (spec §5). A refusal is
        // returned before any successor starts; absent `rerunFromRunId` is plain Resume, path undefined.
        // The raw predecessor tree (`directRuns`, reuse rows and their real statuses intact) is the
        // legal-K input, never the reuse-swapped `originalRuns` below.
        const { rerunFromRunId, ...runOpts } = opts;
        let rerunFromNodePath: string[] | undefined;
        if (rerunFromRunId !== undefined) {
          // The loaded file tree and the root file's own directory let legal-K descend a nested K one
          // level per path element (ADR 0036), resolving each intermediate `workflow` ref against the
          // same tree the run resolves refs against. A top-level K never reads them.
          const verdict = resolveLegalK(rootFile, directRuns, rerunFromRunId, runOpts.files ?? new Map(), workflowDir);
          if (!verdict.ok) return { found: false, refusal: verdict.refusal };
          rerunFromNodePath = verdict.nodePath;
        }

        // A reuse row (#257) is a pointer, not the data: its `runId`/`rootRunId` are this predecessor
        // tree's, but the reused output lives under the *source* run named by `reusedFromRunId`. So
        // before planning reuse, swap each reuse row for that source record — keeping the reuse row's
        // own `parentRunId` so it still scopes under the predecessor run `planReuse` matches against,
        // while `runId`/`rootRunId` become the source so the blob read and the successor's new marker
        // address the source tree directly (ADR 0001, direct-to-source). This is what carries reuse
        // across a chain: without it, `planReuse` would see the pointer's empty successor-tree blob and
        // re-execute. A source whose tree was since `rm`'d resolves to nothing and is dropped — that
        // node re-executes, mirroring the cost query's tolerance of a deleted original.
        const originalRuns = directRuns.flatMap((r) => {
          if (!isReuseRow(r)) return [r];
          const source = getRun(db, r.reusedFromRunId);
          return source ? [{ ...source, parentRunId: r.parentRunId }] : [];
        });

        // The successor's own root run id, captured off its `run-started` (the root one — a nested
        // run's `parentRunId` is non-null). `runWorkflow` mints it internally and returns only a
        // `RunResult`, so an appended observer is how the caller learns which fresh tree it wrote.
        let successorRootRunId: string | undefined;
        const capture: RunObserver = {
          observe(o) {
            if (o.type === "run-started" && o.parentRunId === null) successorRootRunId = o.runId;
          },
        };

        // Read blobs straight out of the original tree, never the successor's: each original run
        // carries the original `rootRunId`, so `runBlobDir` addresses `.path/runs/<orig-root>/…`.
        // This is the only door into the original tree, and it is read-only (resume-restore-semantics.md §4).
        const resume: ResumeInput = {
          originalRuns,
          readBlob: (record, filename) => readJsonBlob(runBlobDir(absDir, record.rootRunId, record.runId), filename),
          rerunFromNodePath,
        };

        const result = await execute(rootFile, workflowDir, runOpts, resume, [capture]);

        // `run-started` precedes every other observation of a tree (run-observer.ts), and the root
        // run always starts, so by here the capture has fired — a missing id would be an engine bug,
        // not an operator error, so assert rather than fold it into `found: false`.
        if (successorRootRunId === undefined) {
          throw new Error("internal error: resumed run emitted no root run-started");
        }
        return {
          found: true,
          rootRunId: successorRootRunId,
          status: result.status,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        };
      },
      listEligible(
        rootFile: WorkflowFile,
        rootRunId: string,
        workflowDir: string,
        files: Map<string, WorkflowFile> = new Map(),
      ): ListEligibleResult {
        // The whole source tree's raw rows (reuse rows and their real statuses intact) — the same
        // `getRunsForRoot` input `resume` feeds `resolveLegalK`, so the verdict per row and the check
        // `resume` runs against one `--from` share the one authority (spec §3).
        const directRuns = getRunsForRoot(db, rootRunId);
        const problem = checkResumeSource(directRuns, rootRunId);
        // Both the unknown-root and non-terminal gates refuse the whole listing and exit 1 with the one
        // message a real resume gives (spec §7) — never a per-row verdict.
        if (problem !== undefined) return { found: false, error: problem.message };

        // One row per node, DFS pre-order (spec §4). Each row's verdict is the shared legal-K predicate
        // over that row's own run id — the root row resolves to reason `root-run`, an eligible node to
        // `ok`, and every other to its §5 taxonomy reason. Never store-rows-only: the file is what tells
        // a top-level node from one nested in a logicer body (spec §3), so `rootFile`/`files` are passed.
        const rows = preorderRuns(directRuns).map((run): EligibilityRow => {
          const verdict = resolveLegalK(rootFile, directRuns, run.runId, files, workflowDir);
          return {
            runId: run.runId,
            nodeName: run.nodeName,
            status: run.status,
            verdict: verdict.ok
              ? { eligible: true }
              : verdict.refusal.container !== undefined
                ? { eligible: false, reason: verdict.refusal.reason, container: verdict.refusal.container }
                : { eligible: false, reason: verdict.refusal.reason },
          };
        });
        return { found: true, rows };
      },
      close(): void {
        db.close();
      },
    },
  };
}
