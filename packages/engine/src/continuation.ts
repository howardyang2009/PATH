import {
  type ConfigObject,
  isReuseRow,
  isRootRun,
  type JsonValue,
  type LaunchFacts,
  type RerunFromNodePathEntry,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";
import type Database from "better-sqlite3";
import { descendNodePath } from "./descend-node-path.js";
import { recoverLaunchConfig, wrapSecretsAtPaths } from "./launch-facts.js";
import { readJsonBlob } from "./persistence/blob-store.js";
import { RUN_BLOB_FILE, runBlobDir } from "./persistence/paths.js";
import { getRun } from "./persistence/run-store.js";
import { recordedChild } from "./resume-plan.js";
import type { ContinueState, RunContext } from "./run-context.js";
import type { RunObserver } from "./run-observer.js";

// A node of a workflow body — the same structural alias `run-workflow.ts` uses; a disposition is
// asked for one node of one file's body.
type WorkflowNode = WorkflowFile["body"][number];

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
export function continuationBlobReader(
  projectDir: string,
): (run: RunRecord, filename: string) => JsonValue {
  return (run, filename) =>
    readJsonBlob(runBlobDir(projectDir, run.rootRunId, run.runId), filename);
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
export function continuationRunOptions<
  T extends { rerunFromRunId?: string; operatorConfig?: ConfigObject },
>(opts: T, frozen: LaunchFacts | undefined): Omit<T, "rerunFromRunId"> & ContinuationOptions {
  const { rerunFromRunId: _boundary, ...runOpts } = opts;
  const suppliedConfig =
    runOpts.operatorConfig === undefined
      ? undefined
      : wrapSecretsAtPaths(runOpts.operatorConfig, frozen?.secretKeys ?? []);
  const { config: recoveredConfig, missingSecretKeys } = recoverLaunchConfig(
    frozen,
    suppliedConfig,
  );

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
        if (observation.type === "run-started" && isRootRun(observation))
          rootRunId = observation.runId;
      },
    },
    rootRunId() {
      if (rootRunId === undefined)
        throw new Error("internal error: resumed run emitted no root run-started");
      return rootRunId;
    },
  };
}

// ── Per-node disposition: the two continuation modes as two adapters ─────────────────────────────

/**
 * What a node's own recorded row says about how the walk should proceed — the **one** answer to
 * "does this node already have a run here, and what does its status mean", read by the three walkers
 * that own one: `runNode` (a leaf or `workflow` step), `runWorkflowNode` (a nested workflow-run
 * re-entered in place) and `runLoopIteration` (a `while-do` iteration container).
 *
 * Resume and Complete are different trees with different rules, so the two modes are two {@link
 * Continuation} adapters, not two arms of one switch. A **Resume** consults the reuse plan: a fresh
 * successor tree whose reused node reads the *original's* recorded output (ADR 0001). A **Complete**
 * consults this same tree's own rows, read-only (ADR 0041): a succeeded row is its own output, a
 * parked row is either the leaf being Completed or a still-parked sibling, and a non-terminal row is
 * re-entered in place.
 */
export type NodeDisposition =
  /**
   * Do not run the node: its output is already recorded. Resume reuses the original tree's run and
   * marks it (`reusedFrom`, ADR 0001); Complete reads this tree's own succeeded row, read-only and
   * unmarked, since it is not a fresh successor tree (ADR 0041).
   */
  | { kind: "reuse"; output: () => JsonValue; reusedFrom?: string }
  /** Complete: this node's row is the parked leaf being Completed — finish that run in place with `output`. */
  | { kind: "complete"; runId: string; output: JsonValue }
  /** Complete: this node's row is a still-parked sibling — park the walk again (park-at-join). */
  | { kind: "park" }
  /**
   * Complete: a non-terminal row this node re-enters in place, keeping its run id (a nested run, an
   * iteration). The whole row, because a re-entered workflow-run restores its parked context from it.
   */
  | { kind: "reenter"; existing: RunRecord }
  /** Nothing recorded answers this node — run it fresh. */
  | { kind: "fresh" };

/**
 * How a continuation directs the walk at one node. Resume and Complete are two trees with two rule
 * sets — a fresh successor consulting a reuse plan; this same tree replayed in place (ADR 0041) — so
 * they are two adapters behind this one seam, not two arms of one switch. `continuationOf` picks the
 * adapter for a run; every walker asks the adapter through this interface and knows neither mode.
 */
export interface Continuation {
  /**
   * The recorded-row verdict for one node of this workflow-run. `iteration` scopes the lookup to a
   * `while-do` iteration container's ordinal (Complete only); every other node leaves it out.
   */
  disposition(node: WorkflowNode, iteration?: number): NodeDisposition;
}

/**
 * The **Resume** adapter (a fresh successor tree): a node reuses when the reuse plan holds a succeeded
 * original run for its id, else it runs fresh. A forward run past its resumed prefix — and every fresh
 * (non-resumed) run — carries an undefined plan and so answers `fresh` at every node.
 */
function resumeContinuation(resume: RunContext["resume"]): Continuation {
  return {
    disposition(node, iteration) {
      // An iteration container is paired through the Resume plan's own iteration scope
      // (`enterIteration`), never through this node-id lookup.
      if (iteration !== undefined) return { kind: "fresh" };
      const original = resume?.plan.get(node.id);
      if (!resume || !original) return { kind: "fresh" };
      return {
        kind: "reuse",
        output: () => resume.input.readBlob(original, RUN_BLOB_FILE.output),
        reusedFrom: original.runId,
      };
    },
  };
}

/**
 * The **Complete** adapter (this tree replayed in place, ADR 0041): the one existing row under this
 * parent whose node id — and, for a `while-do` iteration container, whose `iteration` ordinal —
 * matches directs the walk. A succeeded row is reused read-only; the parked target leaf is completed
 * in place; another parked leaf parks the walk again (park-at-join); a non-terminal row is re-entered
 * only by a node that owns a re-enterable run — a nested `workflow` step or a loop iteration container.
 * A leaf has nothing to re-enter: a Complete replay of a parked tree never finds a live leaf row (the
 * engine tears down at an awaiting leaf, ADR 0039), and a cancelled or failed row is not a state to
 * resume — so a leaf with one runs fresh.
 */
function completeContinuation(state: ContinueState, parentRunId: string): Continuation {
  return {
    disposition(node, iteration) {
      // The one row under this parent answering the node (and, for a loop container, its ordinal):
      // within one tree a single match or none; more than one is a corrupt tree and runs fresh.
      const existing = recordedChild(state.existingRuns, parentRunId, {
        nodeId: node.id,
        iteration,
      });
      if (!existing) return { kind: "fresh" };
      if (existing.status === "succeeded")
        return { kind: "reuse", output: () => readExistingOutput(state, existing) };
      if (existing.status === "awaiting") {
        return existing.runId === state.target.stepRunId
          ? { kind: "complete", runId: existing.runId, output: state.target.output }
          : { kind: "park" };
      }
      if (node.type === "workflow" || iteration !== undefined) return { kind: "reenter", existing };
      return { kind: "fresh" };
    },
  };
}

/**
 * Selects the {@link Continuation} adapter for one workflow-run. `continue` (Complete) and `resume`
 * (Resume) are mutually exclusive by construction — a run is a Complete replay, a Resume successor, or
 * neither — and a plain forward run gets the Resume adapter over an undefined plan, which answers
 * `fresh` for every node.
 */
export function continuationOf(
  run: Pick<RunContext, "continue" | "resume" | "identity">,
): Continuation {
  return run.continue
    ? completeContinuation(run.continue, run.identity.runId)
    : resumeContinuation(run.resume);
}

/** Whether the parked leaf being Completed sits somewhere under `ancestorRunId` in this tree. */
export function targetLeafUnder(state: ContinueState, ancestorRunId: string): boolean {
  const byId = new Map(state.existingRuns.map((r) => [r.runId, r]));
  for (
    let run = byId.get(state.target.stepRunId);
    run;
    run = run.parentRunId === null ? undefined : byId.get(run.parentRunId)
  ) {
    if (run.parentRunId === ancestorRunId) return true;
  }
  return false;
}

/**
 * The recorded output of an existing `succeeded` run of the tree being Completed. Reuse rows were
 * pre-swapped for their source record (`sourceRuns`), so a `succeeded` row always carries its own
 * `outputRef` addressing its output blob; a `{}` fallback covers the theoretical row with no ref.
 */
function readExistingOutput(state: ContinueState, run: RunRecord): JsonValue {
  return run.outputRef ? state.readBlob(run, RUN_BLOB_FILE.output) : {};
}

// ── Resume-from-K rerun boundary: its descent crumbs ─────────────────────────────────────────────

/**
 * The persisted denormalization of the rerun boundary path (ADR 0032/0036): each node id paired with
 * its current human name **at its own level**. `undefined` for plain Resume. The descent resolves each
 * level's name from its own file, following the path-node's `workflow` ref down. Correctness never
 * reads it — it is for #418's descent crumbs — so a name the file no longer carries (or a ref that no
 * longer resolves) falls back to the id.
 */
export function resolveRerunFromNodePath(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  rerunFromNodePath: string[] | undefined,
  rerunFromPasses: (number | null)[] = [],
): RerunFromNodePathEntry[] | undefined {
  if (rerunFromNodePath === undefined || rerunFromNodePath.length === 0) return undefined;
  // One descent of the nested-ref tree (`descendNodePath`); each id paired with its current name at its
  // own level. A level the descent could not reach (a since-removed ref) has no node, so the id is its
  // own fallback — best-effort, since correctness never reads this crumb (#418).
  const { levels } = descendNodePath(rootFile, rootDir, files, rerunFromNodePath);
  // A level whose K sits in a goto pass names the pass too (ADR 0054 §6).
  return rerunFromNodePath.map((id, level) => {
    const pass = rerunFromPasses[level] ?? null;
    return {
      nodeId: id,
      nodeName: levels[level]?.node?.name ?? id,
      ...(pass !== null ? { pass } : {}),
    };
  });
}
