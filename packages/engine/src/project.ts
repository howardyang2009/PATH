import { resolve } from "node:path";
import type { WorkflowFile } from "@path/schema";
import type Database from "better-sqlite3";
import { createLogBackends, DEFAULT_LOG_BACKENDS, type LogBackendId } from "./logging/backends.js";
import type { LogBackend } from "./logging/log-backend.js";
import { createLoggingObserver } from "./logging/logging-observer.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { ensurePathDirGitignore } from "./persistence/gitignore.js";
import { dbFilePath, pathDir } from "./persistence/paths.js";
import { createPersistedObserver } from "./persistence/persisted-observer.js";
import { createRunArchive, type RunArchive } from "./run-archive.js";
import { composeObservers, type RunObserver } from "./run-observer.js";
import { type RunOptions, type RunResult, runWorkflow } from "./run-workflow.js";
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
  /** Closes the db. A `Project` outlives one run (the server holds one per process) and must be closed once. */
  close(): void;
}

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

  return {
    success: true,
    project: {
      dir: absDir,
      archive: createRunArchive(db, absDir),
      settings,
      async run(rootFile: WorkflowFile, workflowDir: string, opts: ProjectRunOptions = {}): Promise<RunResult> {
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
        );

        return runWorkflow(rootFile, workflowDir, {
          ...runOptions,
          observer,
          llmConcurrency: llmConcurrency ?? settings.llmConcurrency,
        });
      },
      close(): void {
        db.close();
      },
    },
  };
}
