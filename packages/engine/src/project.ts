import { resolve } from "node:path";
import type { JsonValue, WorkflowFile } from "@path/schema";
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
  | {
      found: true;
      rootRunId: string;
      status: "succeeded" | "failed" | "cancelled";
      output: JsonValue;
      error?: string;
    };

/**
 * `RunOptions` minus the audit seam, which is the `Project`'s to compose, plus the two engine
 * settings as *overrides* and the two extension points the server needs.
 */
export interface ProjectRunOptions extends Omit<RunOptions, "observer"> {
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  logBackends?: LogBackendId[];
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  llmConcurrency?: number;
  /**
   * Backends alongside the configured ones — the server's live-forwarding backend, which pushes to
   * SSE subscribers regardless of what the run persists to.
   */
  extraBackends?: LogBackend[];
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
    const { logBackends, llmConcurrency, extraBackends = [], extraObservers = [], ...runOptions } = opts;

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
      llmConcurrency: llmConcurrency ?? settings.llmConcurrency,
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
        if (directRuns.length === 0 || !directRuns.some((r) => r.parentRunId === null)) {
          return { found: false, error: `no run found with root run id "${rootRunId}"` };
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
          if (r.reusedFromRunId === null) return [r];
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
        };

        const result = await execute(rootFile, workflowDir, opts, resume, [capture]);

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
      close(): void {
        db.close();
      },
    },
  };
}
