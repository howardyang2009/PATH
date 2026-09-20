import { isReuseRow, isRootRun, type ConfigObject, type JsonValue, type LaunchFacts, type RunRecord } from "@path/schema";
import type Database from "better-sqlite3";
import { recoverLaunchConfig, wrapSecretsAtPaths } from "./launch-facts.js";
import { readJsonBlob } from "./persistence/blob-store.js";
import { runBlobDir } from "./persistence/paths.js";
import { getRun } from "./persistence/run-store.js";
import type { RunObserver } from "./run-observer.js";

/**
 * One **continuation** of an existing run tree, assembled in one place.
 *
 * **What this module exists to own.** Resume and Complete are two engine entry points — one mints a
 * successor tree (CONTEXT.md § Successor run), the other replays the appendable tree in place
 * (ADR 0041) — but they run one recipe, and `Project` wrote it twice: swap each reuse row for the
 * source record it points at, read blobs out of the tree a record belongs to, recover the Launch
 * facts the tree recorded and re-mark whatever secret the operator supplied again, and hand the
 * engine the continuation's options. `launch-facts.ts` claims "one place" for those answers; only its
 * predicate was shared, not the recipe built on it. A fix to the recipe had to land twice.
 *
 * Here it lands once. `Project.resume` and `Project.complete` read these four answers and differ only
 * in which arm of the engine they drive (`ResumeInput` vs `ContinueInput`) — which is the whole
 * difference the domain has between them.
 */

/**
 * The tree's rows with every **reuse row** swapped for the source record it points at (ADR 0001,
 * direct-to-source).
 *
 * A reuse row is a pointer, not the data: its `runId`/`rootRunId` are the predecessor tree's, but the
 * reused output lives under the run named by `reusedFromRunId`. Keeping the reuse row's own
 * `parentRunId` while `runId`/`rootRunId` become the source's is what lets `planReuse` scope the node
 * where it sat *and* lets the blob read and the successor's new reuse-marker address the source tree
 * directly. A source whose tree was since `rm`'d resolves to nothing and is dropped — that node
 * re-executes, mirroring the cost query's tolerance of a deleted original.
 */
export function sourceRuns(db: Database.Database, rows: readonly RunRecord[]): RunRecord[] {
  return rows.flatMap((row) => {
    if (!isReuseRow(row)) return [row];
    const source = getRun(db, row.reusedFromRunId);
    return source ? [{ ...source, parentRunId: row.parentRunId }] : [];
  });
}

/**
 * A reader for one blob of one run, addressed by the record's own `rootRunId` — so a swapped reuse
 * row reads the **source** tree and a re-entered run reads its own. The continuation's only door into
 * the tree it continues, and it is read-only (resume-restore-semantics.md §4).
 */
export function continuationBlobReader(projectDir: string): (run: RunRecord, filename: string) => JsonValue {
  return (run, filename) => readJsonBlob(runBlobDir(projectDir, run.rootRunId, run.runId), filename);
}

/** The launch facts a continuation restores, as the run options the engine executes with. */
export interface ContinuationOptions {
  /** The config to run with: the tree's frozen one, the supplied one, or the supplied over the frozen. */
  operatorConfig?: ConfigObject;
  /**
   * Never re-applied: a continuation restores the **Context** blackboard rather than re-seeding it, so
   * a fresh input seed would be silently discarded. The frozen input is shown to a reader, not replayed.
   */
  operatorInput?: undefined;
  /** The **launch worker-default** table the tree froze (ADR 0044) — the file tier stays live. */
  launchWorkerDefaults?: { [stepType: string]: string };
  /** Frozen config paths whose secret the operator did not supply again — still `[secret:<key>]` tokens. */
  unresolvedLaunchSecrets?: string[];
  /** The paths the tree recorded as secrets, so the continuation's own frozen copy stays honest. */
  inheritedLaunchSecretKeys?: string[];
}

/**
 * The options a continuation runs with, from the facts its tree recorded (ADR 0046) plus whatever the
 * operator supplied this time.
 *
 * A secret supplied again arrives as a plain value — the Viewer types it, the CLI passes it — and a
 * plain value is exactly what the masker does not know about: `collectSecrets` walks `$secret`
 * wrappers, so without {@link wrapSecretsAtPaths} the successor would record the credential in the
 * clear, on disk. Re-marking each supplied value at its recorded path is what puts it back under the
 * one emit choke point, while the worker still receives the real value.
 *
 * `rerunFromRunId` is consumed before this: it selects the **Rerun boundary** for a Resume and is
 * meaningless to a Complete, so it never rides into the run's options.
 */
export function continuationRunOptions<T extends { rerunFromRunId?: string; operatorConfig?: ConfigObject }>(
  opts: T,
  frozen: LaunchFacts | undefined,
): Omit<T, "rerunFromRunId"> & ContinuationOptions {
  const { rerunFromRunId: _boundary, ...runOpts } = opts;
  const suppliedConfig =
    runOpts.operatorConfig === undefined ? undefined : wrapSecretsAtPaths(runOpts.operatorConfig, frozen?.secretKeys ?? []);
  const { config: recoveredConfig, missingSecretKeys } = recoverLaunchConfig(frozen, suppliedConfig);

  return {
    ...runOpts,
    operatorConfig: recoveredConfig,
    operatorInput: undefined,
    launchWorkerDefaults: frozen?.workerDefaults,
    unresolvedLaunchSecrets: missingSecretKeys,
    inheritedLaunchSecretKeys: frozen?.secretKeys,
  };
}

/** A successor tree's own root run id, captured from the engine's own `run-started`. */
export interface SuccessorCapture {
  /** The observer to append to a Resume's run — never a Complete's, which keeps its tree's id. */
  observer: RunObserver;
  /** That id, or a throw: `run-started` precedes every other observation, so its absence is an engine bug. */
  rootRunId(): string;
}

/**
 * `runWorkflow` mints a successor's root run id internally and returns only a `RunResult`, so the
 * caller learns which fresh tree it wrote from the run's own `run-started` — the root one, told apart
 * by `isRootRun`. The ordering that makes this safe (`run-started` precedes every other observation of
 * a tree, and the root run always starts) lives in `run-observer.ts`; asserting it here rather than
 * folding it into `found: false` keeps a broken invariant out of the operator's way.
 */
export function successorCapture(): SuccessorCapture {
  let rootRunId: string | undefined;
  return {
    observer: {
      observe(observation) {
        if (observation.type === "run-started" && isRootRun(observation)) rootRunId = observation.runId;
      },
    },
    rootRunId() {
      if (rootRunId === undefined) throw new Error("internal error: resumed run emitted no root run-started");
      return rootRunId;
    },
  };
}
