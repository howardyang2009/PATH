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

// A node of a workflow body; a disposition is asked for one node of one file's body.
type WorkflowNode = WorkflowFile["body"][number];

/**
 * One continuation of an existing run tree: swap each reuse row for its source record, read blobs from
 * the tree that record belongs to, and restore the Launch facts it recorded.
 */

/**
 * The tree's rows with every reuse row swapped for the source record it points at, keeping the reuse
 * row's own `parentRunId`; a source whose tree was since `rm`'d is dropped and re-executes.
 */
export function sourceRuns(db: Database.Database, rows: readonly RunRecord[]): RunRecord[] {
  return rows.flatMap((row) => {
    if (!isReuseRow(row)) return [row];
    const source = getRun(db, row.reusedFromRunId);
    return source ? [{ ...source, parentRunId: row.parentRunId }] : [];
  });
}

/** Read one blob of one run, addressed by the record's own `rootRunId` so a reused row reads the source tree. */
export function continuationBlobReader(
  projectDir: string,
): (run: RunRecord, filename: string) => JsonValue {
  return (run, filename) =>
    readJsonBlob(runBlobDir(projectDir, run.rootRunId, run.runId), filename);
}

export interface ContinuationOptions {
  operatorConfig?: ConfigObject;
  /** Never re-applied: a continuation restores the Context blackboard, so a fresh input seed would be discarded. */
  operatorInput?: undefined;
  /** The launch worker-default table the tree froze (ADR 0044) — the file tier stays live. */
  launchWorkerDefaults?: { [stepType: string]: string };
  unresolvedLaunchSecrets?: string[];
  inheritedLaunchSecretKeys?: string[];
}

/**
 * The options a continuation runs with. A secret supplied again is a plain value the masker does not
 * know about, so it is re-marked at its recorded path or the successor records it in the clear.
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

export interface SuccessorCapture {
  /** The observer to append to a Resume's run — never a Complete's, which keeps its tree's id. */
  observer: RunObserver;
  /** That id, or a throw: `run-started` precedes every other observation, so its absence is an engine bug. */
  rootRunId(): string;
}

/** Learn a successor's root run id from its own `run-started`; a missing root start throws as an engine bug. */
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

/** What a node's recorded row says about the walk: Resume reads the reuse plan, Complete this tree's own rows. */
export type NodeDisposition =
  /** Do not run the node: Resume reuses the original's output and marks it; Complete reads its own succeeded row. */
  | { kind: "reuse"; output: () => JsonValue; reusedFrom?: string }
  /** Complete: this node's row is the parked leaf being Completed. */
  | { kind: "complete"; runId: string; output: JsonValue }
  /** Complete: this node's row is a still-parked sibling — park the walk again (park-at-join). */
  | { kind: "park" }
  /** Complete: a non-terminal row re-entered in place, keeping its run id; the whole row restores context. */
  | { kind: "reenter"; existing: RunRecord }
  | { kind: "fresh" };

export interface Continuation {
  /** The recorded-row verdict for one node; `iteration` scopes it to a `while-do` container (Complete only). */
  disposition(node: WorkflowNode, iteration?: number): NodeDisposition;
}

/** The Resume adapter: a node reuses when the plan holds a succeeded original for its id, else runs fresh. */
function resumeContinuation(resume: RunContext["resume"]): Continuation {
  return {
    disposition(node, iteration) {
      // Iteration containers pair through the plan's own `enterIteration`, never this node-id lookup.
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
 * The Complete adapter: the one existing row under this parent matching the node id (and a loop's
 * ordinal) directs the walk. Only a nested `workflow` step or a loop container re-enters a non-terminal
 * row; a leaf runs fresh.
 */
function completeContinuation(state: ContinueState, parentRunId: string): Continuation {
  return {
    disposition(node, iteration) {
      // One row under this parent answers the node; more than one is a corrupt tree and runs fresh.
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

/** Select the adapter for one workflow-run; `continue` and `resume` are mutually exclusive by construction. */
export function continuationOf(
  run: Pick<RunContext, "continue" | "resume" | "identity">,
): Continuation {
  return run.continue
    ? completeContinuation(run.continue, run.identity.runId)
    : resumeContinuation(run.resume);
}

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
 * The recorded output of an existing `succeeded` row; reuse rows were pre-swapped, so its own `outputRef` holds it.
 */
function readExistingOutput(state: ContinueState, run: RunRecord): JsonValue {
  return run.outputRef ? state.readBlob(run, RUN_BLOB_FILE.output) : {};
}

/** The persisted denormalization of the rerun boundary path: each node id with its human name at its own level. */
export function resolveRerunFromNodePath(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  rerunFromNodePath: string[] | undefined,
  rerunFromPasses: (number | null)[] = [],
): RerunFromNodePathEntry[] | undefined {
  if (rerunFromNodePath === undefined || rerunFromNodePath.length === 0) return undefined;
  // One descent of the nested-ref tree; a level the descent could not reach falls back to its own id.
  const { levels } = descendNodePath(rootFile, rootDir, files, rerunFromNodePath);
  return rerunFromNodePath.map((id, level) => {
    const pass = rerunFromPasses[level] ?? null;
    return {
      nodeId: id,
      nodeName: levels[level]?.node?.name ?? id,
      ...(pass !== null ? { pass } : {}),
    };
  });
}
