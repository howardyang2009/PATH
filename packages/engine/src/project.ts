import { resolve } from "node:path";
import type { JsonValue, WorkflowFile } from "@path/schema";
import type Database from "better-sqlite3";
import { createLogBackends, DEFAULT_LOG_BACKENDS, type LogBackendId } from "./logging/backends.js";
import type { LogBackend } from "./logging/log-backend.js";
import { createLoggingObserver } from "./logging/logging-observer.js";
import { openRunLog } from "./logging/run-log.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { ensurePathDirGitignore } from "./persistence/gitignore.js";
import { dbFilePath, pathDir } from "./persistence/paths.js";
import { createPersistedObserver } from "./persistence/persisted-observer.js";
import { type CompleteResult, cancelAwaitingRun, completeProjectStep } from "./project-complete.js";
import {
  type ListEligibleResult,
  listEligibleRuns,
  type ResumeResult,
  resumeProjectRun,
} from "./project-resume.js";
import { createRunArchive, type RunArchive } from "./run-archive.js";
import { composeObservers, type RunObserver } from "./run-observer.js";
import {
  type ContinuationInput,
  type ContinuationRunOptions,
  type LaunchRunOptions,
  type RunResult,
  type RunSeams,
  runWorkflow,
} from "./run-workflow.js";
import { type EngineSettings, loadEngineSettings } from "./settings/engine-settings.js";

export type { CompleteResult } from "./project-complete.js";
export type {
  EligibilityRow,
  EligibilityVerdict,
  ListEligibleResult,
  ResumeRefusal,
  ResumeResult,
} from "./project-resume.js";

/**
 * A project directory, opened: the `.path/` beside a workflow, its db, settings and the one way to
 * run a workflow against it. A `Project` owns all `.path/` knowledge; the CLI and server keep the
 * rest.
 */
export interface Project {
  /** The absolute project directory: where `.path/` is read and written. Never a workflow's own
   * directory. */
  readonly dir: string;
  /** This project's runs read back: rows, blobs and narratives over the same open db `run` writes
   * to. */
  readonly archive: RunArchive;
  /** `.path/settings.json` as loaded at open time (mvp spec §9) — `{}` when the file is absent. */
  readonly settings: EngineSettings;
  /**
   * Run one workflow against this project. `workflowDir` is the root workflow file's own directory,
   * which nested `workflow` refs and binary `cwd`s resolve against — not `dir`.
   */
  run(rootFile: WorkflowFile, workflowDir: string, opts?: ProjectLaunchOptions): Promise<RunResult>;
  /**
   * Resume a prior root run: re-run `rootFile` as a successor of the tree rooted at `rootRunId`,
   * reusing every node whose recorded run still matches, the original tree left read-only. `found:
   * false` when `rootRunId` is unknown, else `found: true` with the successor's own root run id.
   */
  resume(
    rootFile: WorkflowFile,
    rootRunId: string,
    workflowDir: string,
    opts?: ProjectResumeOptions,
  ): Promise<ResumeResult>;
  /**
   * Dry-run of resume: compute but launch nothing — DFS pre-order runs, each with the verdict the
   * same `resolveLegalK` authority gives `--from`. An unknown or non-terminal source refuses the
   * command.
   */
  listEligible(
    rootFile: WorkflowFile,
    rootRunId: string,
    workflowDir: string,
    files?: Map<string, WorkflowFile>,
  ): ListEligibleResult;
  /**
   * Complete a parked `awaiting` leaf: replay its tree from the root, reusing `succeeded` rows,
   * then flip the leaf `awaiting → succeeded` and append forward in the same tree. A per-root-run
   * expiring lease admits one Complete at a time (`lease-held`) and a leaf compare-and-swap rejects
   * a non-`awaiting` leaf (`not-awaiting`); output is validated first (`node-gone`,
   * `output-invalid`).
   */
  complete(
    rootFile: WorkflowFile,
    stepRunId: string,
    output: JsonValue,
    workflowDir: string,
    opts?: ProjectContinuationOptions,
  ): Promise<CompleteResult>;
  /**
   * Cancel a parked `awaiting` tree at the store (`awaiting → cancelled`, ancestors too): a park
   * tears the engine down, so there is no live process to abort. `false` when the tree is unknown,
   * terminal, not parked, or lease-held.
   */
  cancel(rootRunId: string): boolean;
  close(): void;
}

/** What the `Project` adds to a run's own options, whichever mode: settings overrides and seams. */
export interface ProjectRunSeams {
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /** Backends alongside the configured ones — the server's live SSE forwarding. */
  extraBackends?: LogBackend[];
  /**
   * Appended after the built-in pair, always: the capture observer must run after persistence wrote
   * the row and logging opened its channel.
   */
  extraObservers?: RunObserver[];
}

/** A `Project.run` call: the launch arm, so an operator input is the one thing it can carry that a
 * continuation cannot. The continuation itself is the assembly's to add, never the caller's. */
export type ProjectLaunchOptions = Omit<LaunchRunOptions, "observer" | "continuation"> &
  ProjectRunSeams;

/** A `Project.resume` / `Project.complete` call: the continuation arm, likewise without the
 * continuation object. */
export type ProjectContinuationOptions = Omit<ContinuationRunOptions, "observer" | "continuation"> &
  ProjectRunSeams;

/** A Resume adds the rerun boundary K to the continuation arm (ADR 0032); Complete has no K. */
export type ProjectResumeOptions = ProjectContinuationOptions & { rerunFromRunId?: string };

/** Either arm, as a caller states it. */
export type ProjectRunOptions = ProjectLaunchOptions | ProjectContinuationOptions;

/** Either arm as the run assembly receives it: the caller's options with the continuation the
 * assembly built for it. */
export type ProjectExecOptions =
  | (ProjectLaunchOptions & { continuation?: undefined })
  | (ProjectContinuationOptions & { continuation: ContinuationInput });

/** What both arms share: a caller that builds one options object for launch and resume (the CLI)
 * states only these, so no mode-specific field is in scope to leak into the wrong call. */
export type ProjectSharedOptions = Omit<RunSeams, "observer"> & ProjectRunSeams;

/** What the resume and complete paths share with `openProject`: the open db, the project dir, and
 * the run assembly. */
export interface ProjectCore {
  db: Database.Database;
  absDir: string;
  execute(
    rootFile: WorkflowFile,
    workflowDir: string,
    options: ProjectExecOptions,
    appendObservers: RunObserver[],
  ): Promise<RunResult>;
}

/** `kind` survives the return so the CLI can exit 2 for a bad settings file, 1 for an unopenable
 * db. */
export type OpenProjectResult =
  | { success: true; project: Project }
  | { success: false; kind: "settings" | "db"; error: string };

/** Opens a project directory. Ordering matters: the gitignore call creates `.path/` before
 * `openDb`. */
export function openProject(dir: string): OpenProjectResult {
  const absDir = resolve(dir);
  ensurePathDirGitignore(pathDir(absDir));

  // Engine settings, strictly apart from workflow Config: read by the engine, never merged into
  // `${config.x}`.
  const loaded = loadEngineSettings(absDir);
  if (!loaded.success) return { success: false, kind: "settings", error: loaded.error };

  let db: Database.Database;
  try {
    db = openDb(dbFilePath(absDir));
  } catch (err) {
    const error =
      err instanceof SchemaVersionError ? err.message : `cannot open .path/path.db: ${String(err)}`;
    return { success: false, kind: "db", error };
  }

  const settings = loaded.settings;

  /**
   * The assembly `run` and `resume` share: backend selection, the persistence-before-logging
   * observer pair, settings precedence and the `runWorkflow` call.
   */
  function execute(
    rootFile: WorkflowFile,
    workflowDir: string,
    options: ProjectExecOptions,
    appendObservers: RunObserver[],
  ): Promise<RunResult> {
    const {
      logBackends,
      processorConcurrency,
      extraBackends = [],
      extraObservers = [],
      ...runOptions
    } = options;

    // Nearest wins: an explicit override beats `.path/settings.json`, which beats the built-in
    // default.
    const backendIds = logBackends ?? settings.logBackends ?? DEFAULT_LOG_BACKENDS;
    const backends = createLogBackends(backendIds, { db, projectDir: absDir });

    // A Complete continues the existing per-root log stream: seq picks up from `RunLog.lastSeq()`
    // and events append to `run.log` rather than truncating it.
    const loggingOptions =
      runOptions.continuation?.kind === "complete"
        ? {
            startSeq: openRunLog(absDir, db, runOptions.continuation.rootRunId).lastSeq(),
            append: true,
          }
        : {};

    // Persistence first, deliberately: a log write failure aborts the remaining observers, so
    // logging first would leave a failed audit with no run row.
    const observer = composeObservers(
      createPersistedObserver(db, absDir),
      createLoggingObserver([...backends, ...extraBackends], loggingOptions),
      ...extraObservers,
      ...appendObservers,
    );

    return runWorkflow(rootFile, workflowDir, {
      ...runOptions,
      observer,
      processorConcurrency: processorConcurrency ?? settings.processorConcurrency,
    });
  }

  const core: ProjectCore = { db, absDir, execute };
  return {
    success: true,
    project: {
      dir: absDir,
      archive: createRunArchive(db, absDir),
      settings,
      run: (rootFile, workflowDir, opts = {}) =>
        execute(rootFile, workflowDir, { ...opts, continuation: undefined }, []),
      resume: (rootFile, rootRunId, workflowDir, opts = {}) =>
        resumeProjectRun(core, rootFile, rootRunId, workflowDir, opts),
      listEligible: (rootFile, rootRunId, workflowDir, files = new Map()) =>
        listEligibleRuns(core, rootFile, rootRunId, workflowDir, files),
      complete: (rootFile, stepRunId, output, workflowDir, opts = {}) =>
        completeProjectStep(core, rootFile, stepRunId, output, workflowDir, opts),
      cancel: (rootRunId) => cancelAwaitingRun(core, rootRunId),
      close(): void {
        db.close();
      },
    },
  };
}
