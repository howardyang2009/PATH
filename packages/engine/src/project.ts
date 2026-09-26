import { resolve } from "node:path";
import {
  childrenByParent,
  findRootRun,
  isTerminal,
  type JsonValue,
  type RunRecord,
  type RunStatus,
  type WorkflowFile,
} from "@path/schema";
import type Database from "better-sqlite3";
import { checkCompletedOutput } from "./complete-output.js";
import {
  continuationBlobReader,
  continuationRunOptions,
  sourceRuns,
  successorCapture,
} from "./continuation.js";
import { createLogBackends, DEFAULT_LOG_BACKENDS, type LogBackendId } from "./logging/backends.js";
import type { LogBackend } from "./logging/log-backend.js";
import { createLoggingObserver } from "./logging/logging-observer.js";
import { openRunLog } from "./logging/run-log.js";
import { acquireCompleteLease } from "./persistence/complete-lease.js";
import { openDb, SchemaVersionError } from "./persistence/db.js";
import { ensurePathDirGitignore } from "./persistence/gitignore.js";
import { dbFilePath, pathDir } from "./persistence/paths.js";
import { createPersistedObserver } from "./persistence/persisted-observer.js";
import {
  cancelNonTerminalRuns,
  getLaunchFacts,
  getRun,
  getRunsForRoot,
} from "./persistence/run-store.js";
import { type LegalKContainer, type LegalKReasonCode, resolveLegalK } from "./resume-legal-k.js";
import { createRunArchive, type RunArchive } from "./run-archive.js";
import { composeObservers, type RunObserver } from "./run-observer.js";
import {
  type ContinueInput,
  type ResumeInput,
  type RunOptions,
  type RunResult,
  runWorkflow,
} from "./run-workflow.js";
import { type EngineSettings, loadEngineSettings } from "./settings/engine-settings.js";

/**
 * A project directory, opened: the `.path/` beside a workflow, its db, settings and the one way to run
 * a workflow against it. A `Project` owns all `.path/` knowledge; the CLI and server keep the rest.
 */
export interface Project {
  /** The absolute project directory: where `.path/` is read and written. Never a workflow's own directory. */
  readonly dir: string;
  /** This project's runs read back: rows, blobs and narratives over the same open db `run` writes to. */
  readonly archive: RunArchive;
  /** `.path/settings.json` as loaded at open time (mvp spec §9) — `{}` when the file is absent. */
  readonly settings: EngineSettings;
  /**
   * Run one workflow against this project. `workflowDir` is the root workflow file's own directory, which nested
   * `workflow` refs and binary `cwd`s resolve against — not `dir`.
   */
  run(rootFile: WorkflowFile, workflowDir: string, opts?: ProjectRunOptions): Promise<RunResult>;
  /**
   * Resume a prior root run: re-run `rootFile` as a successor of the tree rooted at `rootRunId`,
   * reusing every node whose recorded run still matches, the original tree left read-only. `found:
   * false` when `rootRunId` is unknown, else `found: true` with the successor's own root run id.
   */
  resume(
    rootFile: WorkflowFile,
    rootRunId: string,
    workflowDir: string,
    opts?: ProjectRunOptions,
  ): Promise<ResumeResult>;
  /**
   * Dry-run of resume: compute but launch nothing — DFS pre-order runs, each with the verdict the same
   * `resolveLegalK` authority gives `--from`. An unknown or non-terminal source refuses the command.
   */
  listEligible(
    rootFile: WorkflowFile,
    rootRunId: string,
    workflowDir: string,
    files?: Map<string, WorkflowFile>,
  ): ListEligibleResult;
  /**
   * Complete a parked `awaiting` leaf: replay its tree from the root, reusing `succeeded` rows, then
   * flip the leaf `awaiting → succeeded` and append forward in the same tree. A per-root-run expiring
   * lease admits one Complete at a time (`lease-held`) and a leaf compare-and-swap rejects a
   * non-`awaiting` leaf (`not-awaiting`); output is validated first (`node-gone`, `output-invalid`).
   */
  complete(
    rootFile: WorkflowFile,
    stepRunId: string,
    output: JsonValue,
    workflowDir: string,
    opts?: ProjectRunOptions,
  ): Promise<CompleteResult>;
  /**
   * Cancel a parked `awaiting` tree at the store (`awaiting → cancelled`, ancestors too): a park tears
   * the engine down, so there is no live process to abort. `false` when the tree is unknown, terminal,
   * not parked, or lease-held.
   */
  cancel(rootRunId: string): boolean;
  close(): void;
}

/**
 * The outcome of `Project.complete`: a Result because "no such leaf", "not awaiting" and "lease held" are ordinary
 * states the route maps to a status code.
 */
export type CompleteResult =
  | {
      ok: false;
      reason: "not-found" | "not-awaiting" | "lease-held" | "node-gone";
      message: string;
    }
  | { ok: false; reason: "output-invalid"; message: string; details?: unknown[] }
  | {
      ok: true;
      rootRunId: string;
      status: "succeeded" | "failed" | "cancelled" | "awaiting";
      output: JsonValue;
      error?: string;
    };

/**
 * The outcome of `Project.resume`: a Result because "no such root run" is ordinary operator input; `found: true`
 * carries the successor's own fresh root run id.
 */
export type ResumeResult =
  | { found: false; error: string }
  | { found: false; refusal: ResumeRefusal }
  | {
      found: true;
      rootRunId: string;
      // `awaiting` when the successor re-ran a person-activity step and parked; its root stays `running`.
      status: "succeeded" | "failed" | "cancelled" | "awaiting";
      output: JsonValue;
      error?: string;
    };

/**
 * A Resume-from-K refusal: the legal-K authority rejected `rerunFromRunId` before any successor started. `status`
 * follows the §5 taxonomy (400 unsupported, 409 conflict).
 */
export interface ResumeRefusal {
  status: number;
  message: string;
}

/**
 * One node's `--list-eligible` verdict: `eligible: true` when it is a legal K, else the §5 taxonomy
 * classification of why — the same one `resolveLegalK` attaches to a `--from` refusal.
 */
export type EligibilityVerdict =
  | { eligible: true }
  | { eligible: false; reason: LegalKReasonCode; container?: LegalKContainer };

/** One row of the `--list-eligible` listing: a source-tree run and its eligibility verdict. */
export interface EligibilityRow {
  runId: string;
  /** The producing node's human `name`; null for the root run (the CLI renders `-`). */
  nodeName: string | null;
  status: RunStatus;
  verdict: EligibilityVerdict;
}

/**
 * The outcome of `Project.listEligible`: `found: false` carries the message a resume of this root would; `found:
 * true` carries every source-tree run in DFS pre-order.
 */
export type ListEligibleResult =
  | { found: false; error: string }
  | { found: true; rows: EligibilityRow[] };

/**
 * The precondition `resume` and `listEligible` share: the source tree named by `rootRunId` must exist
 * and be terminal. `getRunsForRoot` keys on `root_run_id`, so a child id returns no rows — the same
 * `not-found` case; terminality is read off the root row, a non-terminal source refused whole.
 */
type ResumeSourceProblem =
  | { kind: "not-found"; message: string }
  | { kind: "non-terminal"; message: string };

function checkResumeSource(rows: RunRecord[], rootRunId: string): ResumeSourceProblem | undefined {
  const root = findRootRun(rows);
  if (rows.length === 0 || !root) {
    return { kind: "not-found", message: `no run found with root run id "${rootRunId}"` };
  }
  if (!isTerminal(root.status)) {
    return {
      kind: "non-terminal",
      message: `run "${rootRunId}" is still ${root.status}; resume needs a terminal source run`,
    };
  }
  return undefined;
}

/** The source tree's runs in depth-first pre-order: a node under its parent, children in stored order. */
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

/** `RunOptions` minus the audit seam (the `Project` composes it), plus setting overrides and seams. */
export interface ProjectRunOptions extends Omit<RunOptions, "observer"> {
  /** Overrides `.path/settings.json`, which overrides the built-in default. */
  logBackends?: LogBackendId[];
  processorConcurrency?: number;
  /** Backends alongside the configured ones — the server's live SSE forwarding. */
  extraBackends?: LogBackend[];
  /** Resume-only: the operator's source run id naming the rerun boundary K. Absent = plain Resume. */
  rerunFromRunId?: string;
  /**
   * Appended after the built-in pair, always: the capture observer must run after persistence wrote the row and
   * logging opened its channel.
   */
  extraObservers?: RunObserver[];
}

/** `kind` survives the return so the CLI can exit 2 for a bad settings file, 1 for an unopenable db. */
export type OpenProjectResult =
  | { success: true; project: Project }
  | { success: false; kind: "settings" | "db"; error: string };

/** Opens a project directory. Ordering matters: the gitignore call creates `.path/` before `openDb`. */
export function openProject(dir: string): OpenProjectResult {
  const absDir = resolve(dir);
  ensurePathDirGitignore(pathDir(absDir));

  // Engine settings, strictly apart from workflow Config: read by the engine, never merged into `${config.x}`.
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
   * The assembly `run` and `resume` share: backend selection, the persistence-before-logging observer pair,
   * settings precedence and the `runWorkflow` call.
   */
  function execute(
    rootFile: WorkflowFile,
    workflowDir: string,
    opts: ProjectRunOptions,
    resume: ResumeInput | undefined,
    appendObservers: RunObserver[],
    continueInput?: ContinueInput,
  ): Promise<RunResult> {
    const {
      logBackends,
      processorConcurrency,
      extraBackends = [],
      extraObservers = [],
      ...runOptions
    } = opts;

    // Nearest wins: an explicit override beats `.path/settings.json`, which beats the built-in default.
    const backendIds = logBackends ?? settings.logBackends ?? DEFAULT_LOG_BACKENDS;
    const backends = createLogBackends(backendIds, { db, projectDir: absDir });

    // A Complete continues the existing per-root log stream: seq picks up from `RunLog.lastSeq()` and events append
    // to `run.log` rather than truncating it.
    const loggingOptions = continueInput
      ? { startSeq: openRunLog(absDir, db, continueInput.rootRunId).lastSeq(), append: true }
      : {};

    // Persistence first, deliberately: a log write failure aborts the remaining observers, so logging first would
    // leave a failed audit with no run row.
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
      resume,
      continue: continueInput,
    });
  }

  return {
    success: true,
    project: {
      dir: absDir,
      archive: createRunArchive(db, absDir),
      settings,
      run(
        rootFile: WorkflowFile,
        workflowDir: string,
        opts: ProjectRunOptions = {},
      ): Promise<RunResult> {
        return execute(rootFile, workflowDir, opts, undefined, []);
      },
      async resume(
        rootFile: WorkflowFile,
        rootRunId: string,
        workflowDir: string,
        opts: ProjectRunOptions = {},
      ): Promise<ResumeResult> {
        // The raw predecessor tree, read once. `getRunsForRoot` keys on `root_run_id`, so an unknown or child id
        // yields no rows — the `found: false` case.
        const directRuns = getRunsForRoot(db, rootRunId);
        const problem = checkResumeSource(directRuns, rootRunId);
        if (problem !== undefined) {
          // Unknown root stays `error`; a non-terminal source is a 409 refusal. Both exit 1 on the CLI.
          return problem.kind === "not-found"
            ? { found: false, error: problem.message }
            : { found: false, refusal: { status: 409, message: problem.message } };
        }

        // Resume-from-K: resolve the source run id to the boundary node-id path and enforce legal-K here — the one
        // authority. The raw predecessor tree is the input, never the swapped one.
        const { rerunFromRunId, ...runOpts } = opts;
        let rerunFromNodePath: string[] | undefined;
        let rerunFromPasses: (number | null)[] | undefined;
        if (rerunFromRunId !== undefined) {
          // `files`/`workflowDir` let legal-K descend a nested K, one level per path element.
          const verdict = resolveLegalK(
            rootFile,
            directRuns,
            rerunFromRunId,
            runOpts.files ?? new Map(),
            workflowDir,
          );
          if (!verdict.ok) return { found: false, refusal: verdict.refusal };
          rerunFromNodePath = verdict.nodePath;
          rerunFromPasses = verdict.passes;
        }

        // The continuation recipe Resume and Complete share: rows with reuse rows swapped for their source, a
        // read-only blob reader, and the recorded launch facts.
        const originalRuns = sourceRuns(db, directRuns);
        const capture = successorCapture();
        const resume: ResumeInput = {
          originalRuns,
          readBlob: continuationBlobReader(absDir),
          rerunFromNodePath,
          rerunFromPasses,
        };

        const result = await execute(
          rootFile,
          workflowDir,
          // Launch facts are identity-defining like `input` (ADR 0046): a resume recovers the predecessor's frozen
          // config and worker defaults; the file tier stays live.
          continuationRunOptions(runOpts, getLaunchFacts(db, rootRunId)),
          resume,
          [capture.observer],
        );

        return {
          found: true,
          rootRunId: capture.rootRunId(),
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
        // The same raw rows `resume` feeds `resolveLegalK`, so the per-row verdict shares one authority.
        const directRuns = getRunsForRoot(db, rootRunId);
        const problem = checkResumeSource(directRuns, rootRunId);
        if (problem !== undefined) return { found: false, error: problem.message };

        // DFS pre-order, one row per run; each verdict is the shared legal-K predicate over that run id.
        const rows = preorderRuns(directRuns).map((run): EligibilityRow => {
          const verdict = resolveLegalK(rootFile, directRuns, run.runId, files, workflowDir);
          return {
            runId: run.runId,
            nodeName: run.nodeName,
            status: run.status,
            verdict: verdict.ok
              ? { eligible: true }
              : verdict.refusal.container !== undefined
                ? {
                    eligible: false,
                    reason: verdict.refusal.reason,
                    container: verdict.refusal.container,
                  }
                : { eligible: false, reason: verdict.refusal.reason },
          };
        });
        return { found: true, rows };
      },
      async complete(
        rootFile: WorkflowFile,
        stepRunId: string,
        output: JsonValue,
        workflowDir: string,
        opts: ProjectRunOptions = {},
      ): Promise<CompleteResult> {
        // An unknown id is `not-found` (404); a leaf not `awaiting` — already succeeded, or a double-submit — is
        // `not-awaiting` (409).
        const leaf = getRun(db, stepRunId);
        if (leaf === undefined) {
          return {
            ok: false,
            reason: "not-found",
            message: `no step run found with id "${stepRunId}"`,
          };
        }
        if (leaf.status !== "awaiting") {
          return {
            ok: false,
            reason: "not-awaiting",
            message: `step run "${stepRunId}" is ${leaf.status}, not awaiting`,
          };
        }
        const rootRunId = leaf.rootRunId;
        // The appendable window closes when the tree reaches a terminal status: a leaf left `awaiting` under a tree
        // settled by another path is never re-driven.
        const rootRow = getRun(db, rootRunId);
        if (rootRow !== undefined && isTerminal(rootRow.status)) {
          return {
            ok: false,
            reason: "not-awaiting",
            message: `run "${rootRunId}" already finished with status "${rootRow.status}"`,
          };
        }

        // Validation before the lease: it is per-leaf, the lease per-tree, so a bad submit never contends for the
        // lease a valid sibling needs.
        const runOptions = continuationRunOptions(opts, getLaunchFacts(db, rootRunId));
        const check = checkCompletedOutput({
          rootFile,
          workflowDir,
          files: opts.files,
          operatorConfig: runOptions.operatorConfig,
          env: { ...process.env },
          stepRunId,
          nodeId: leaf.nodeId,
          output,
        });
        if (!check.ok) return check;

        // Per-root-run expiring lease: a held lease rejects (`lease-held` → 409) rather than queueing.
        const lease = acquireCompleteLease(absDir, rootRunId);
        if (lease === null) {
          return {
            ok: false,
            reason: "lease-held",
            message: `run "${rootRunId}" is being completed in another invocation`,
          };
        }
        try {
          // Re-read under the lease to close the TOCTOU against a Complete that flipped this leaf.
          const fresh = getRun(db, stepRunId);
          if (fresh === undefined || fresh.status !== "awaiting") {
            return {
              ok: false,
              reason: "not-awaiting",
              message: `step run "${stepRunId}" is ${fresh?.status ?? "gone"}, not awaiting`,
            };
          }

          // The continuation recipe `resume` uses: reuse rows swapped for their source record, so a reused
          // `succeeded` row addresses its own output blob.
          const directRuns = getRunsForRoot(db, rootRunId);
          const continueInput: ContinueInput = {
            rootRunId,
            existingRuns: sourceRuns(db, directRuns),
            readBlob: continuationBlobReader(absDir),
            target: { stepRunId, output },
          };

          const result = await execute(
            rootFile,
            workflowDir,
            // A Complete replays the same tree, so it restores that tree's recorded launch facts: the launch config
            // (with any supplied secret merged over it) and its worker defaults.
            runOptions,
            undefined,
            [],
            continueInput,
          );
          return {
            ok: true,
            rootRunId,
            status: result.status,
            output: result.output,
            ...(result.error !== undefined ? { error: result.error } : {}),
          };
        } finally {
          lease.release();
        }
      },
      cancel(rootRunId: string): boolean {
        const rows = getRunsForRoot(db, rootRunId);
        const root = findRootRun(rows);
        // Unknown or already-terminal trees are the route's to answer (404 / already-finished).
        if (!root || isTerminal(root.status)) return false;
        // Only a *parked* tree is safe to cancel here: an `awaiting` leaf means the engine tore down; a non-terminal
        // tree without one may be live elsewhere.
        if (!rows.some((r) => r.status === "awaiting")) return false;
        // Take the Complete lease so this never races a Complete advancing the same tree.
        const lease = acquireCompleteLease(absDir, rootRunId);
        if (lease === null) return false;
        try {
          cancelNonTerminalRuns(db, rootRunId);
          return true;
        } finally {
          lease.release();
        }
      },
      close(): void {
        db.close();
      },
    },
  };
}
