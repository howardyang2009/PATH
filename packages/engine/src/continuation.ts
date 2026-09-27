import {
  type ConfigObject,
  type GotoNode,
  isPassRun,
  isReuseRow,
  type JsonValue,
  type LaunchFacts,
  must,
  pathToRoot,
  type RerunFromNodePathEntry,
  type RunRecord,
  serialOrder,
  type WorkflowFile,
} from "@path/schema";
import type Database from "better-sqlite3";
import { descendNodePath } from "./descend-node-path.js";
import { recoverLaunchConfig, wrapSecretsAtPaths } from "./launch-facts.js";
import { readJsonBlob } from "./persistence/blob-store.js";
import { RUN_BLOB_FILE, runBlobDir } from "./persistence/paths.js";
import { getRun } from "./persistence/run-store.js";
import { pickReusedWaitOneWinner, recordedChild } from "./plan-reuse.js";
import {
  enterIteration,
  enterNested,
  passResumer,
  type ResumeEntry,
  type RunResume,
  resolveResume,
  resumeSeed,
} from "./resume-plan.js";
import type { ChildRunKey, ContinueState, RunIdentity } from "./run-context.js";
import type { RunObserver } from "./run-observer.js";

/** A node of a workflow body; a disposition is asked for one node of one file's body. */
type WorkflowNode = WorkflowFile["body"][number];
type ParallelNode = Extract<WorkflowNode, { type: "parallel" }>;
type ParallelBranch = ParallelNode["branches"][number];

/**
 * The continuation recipe Resume and Complete share: swap each reuse row for its source record, read
 * blobs from the tree that record belongs to, and restore the Launch facts it recorded. The two
 * **modes** differ only in the {@link Continuation} they hand the walkers.
 */

/**
 * The tree's rows with every reuse row swapped for the source record it points at, keeping the
 * reuse row's own `parentRunId`; a source whose tree was since `rm`'d is dropped and re-executes.
 */
export function sourceRuns(db: Database.Database, rows: readonly RunRecord[]): RunRecord[] {
  return rows.flatMap((row) => {
    if (!isReuseRow(row)) return [row];
    const source = getRun(db, row.reusedFromRunId);
    return source ? [{ ...source, parentRunId: row.parentRunId }] : [];
  });
}

/** Read one blob of one run, addressed by the record's own `rootRunId` so a reused row reads the
 * source tree. */
export function continuationBlobReader(
  projectDir: string,
): (run: RunRecord, filename: string) => JsonValue {
  return (run, filename) =>
    readJsonBlob(runBlobDir(projectDir, run.rootRunId, run.runId), filename);
}

export interface ContinuationOptions {
  operatorConfig?: ConfigObject;
  /** Never re-applied: a continuation restores the Context blackboard, so a fresh input seed would
   * be discarded. */
  operatorInput?: undefined;
  /** The launch worker-default table the tree froze (ADR 0044) — the file tier stays live. */
  launchWorkerDefaults?: { [stepType: string]: string };
  unresolvedLaunchSecrets?: string[];
  inheritedLaunchSecretKeys?: string[];
}

/**
 * The options a continuation runs with. A secret supplied again is a plain value the masker does
 * not know about, so it is re-marked at its recorded path or the successor records it in the clear.
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
  /** That id, or a throw: the root run's start precedes every other event, so its absence is an
   * engine bug. */
  rootRunId(): string;
}

/** Learn a successor's root run id from its own events; a missing root start throws as an engine
 * bug. */
export function successorCapture(): SuccessorCapture {
  let rootRunId: string | undefined;
  return {
    observer: {
      observe(e) {
        if (e.runId === e.rootRunId) rootRunId = e.runId;
      },
    },
    rootRunId() {
      if (rootRunId === undefined)
        throw new Error("internal error: resumed run emitted no root start");
      return rootRunId;
    },
  };
}

/**
 * What a node's recorded row says about the walk: Resume reads its reuse plan, Complete this tree's
 * own rows. The five answers are the whole mode difference a walker sees.
 */
export type NodeDisposition =
  /** Do not run the node: Resume reuses the original's output and marks it; Complete reads its own
   * succeeded row. */
  | { kind: "reuse"; output: () => JsonValue; reusedFrom?: string }
  /** Complete: this node's row is the parked leaf being Completed. */
  | { kind: "complete"; runId: string; output: JsonValue }
  /** Complete: this node's row is a still-parked sibling — park the walk again (park-at-join). */
  | { kind: "park" }
  /** Complete: a non-terminal row re-entered in place, keeping its run id; the whole row restores
   * context. */
  | { kind: "reenter"; existing: RunRecord }
  | { kind: "fresh" };

/** Where a top-level walk with passes starts. */
export interface PassWalkStart {
  pass: number;
  /** The starting pass's opener; `null` for pass 1. */
  opener: GotoNode | null;
  start: number;
  /** The walk's seed for pass 1, the recorded pass input on a re-entry. */
  carried: JsonValue;
  jumpsSpent: Map<string, number>;
  /** The recorded `running` pass a Complete re-enters in place (same id, no second start). */
  reentered: RunRecord | undefined;
}

/** The parked leaf a diverged Complete still commits (ADR 0060 §2). */
export interface ParkedLeaf {
  runId: string;
  node: { id: string; name: string };
  output: JsonValue;
}

/** A Complete whose running pass no longer matches the reloaded file (ADR 0060 §2); a parked leaf
 * under that pass is still committed first, so a later Resume reuses it instead of asking again. */
export interface PassDivergence {
  diverged: RunRecord;
  error: string;
  commit: ParkedLeaf | undefined;
}

/**
 * One run's view of what is already recorded under it: what each child node means, where a
 * re-entered run's blackboard starts, and how the answer scopes to a nested run, a loop iteration or
 * a goto pass. Resume and Complete differ only in the implementation, never in the walker's question.
 */
export interface Continuation {
  /** The recorded-row verdict for one node; `ordinal` scopes a `while-do` container. */
  disposition(node: WorkflowNode, ordinal?: number): NodeDisposition;
  /** The seed a re-entered workflow-run replays from (Resume root, ADR 0062), or `undefined` to
   * take the run's own interpolated input. */
  seed(): { [key: string]: JsonValue } | undefined;
  /** The row this run re-enters in place, with the parked blackboard it restores (Complete); its
   * presence is why a re-entry skips its `step-started`. */
  reentry(): { existing: RunRecord; context: { [key: string]: JsonValue } } | undefined;
  /** The continuation for a child run opened under this one: a nested `workflow` step, a `while-do`
   * iteration container or a goto pass container. `file` is the child run's file. */
  enter(key: ChildRunKey, file: WorkflowFile, identity: RunIdentity): Continuation;
  /** The starting state of this run's **top-level walk**, or the divergence a Complete fails on. */
  passWalk(
    gotos: ReadonlyMap<string, GotoNode>,
    seedInput: JsonValue,
  ): PassWalkStart | PassDivergence;
  /** The already-decided `wait-one` winner to replay without running the losers, if any. */
  decidedRaceWinner(node: ParallelNode): ParallelBranch | undefined;
}

/** A launch's continuation: nothing is recorded, so every node runs fresh. */
const FRESH: Continuation = {
  disposition: () => ({ kind: "fresh" }),
  seed: () => undefined,
  reentry: () => undefined,
  enter: () => FRESH,
  decidedRaceWinner: () => undefined,
  passWalk: (_gotos, seedInput) => freshPassWalk(seedInput),
};

/** The continuation a run with no predecessor walks with. */
export function noContinuation(): Continuation {
  return FRESH;
}

/** The Resume adapter: a successor tree that reuses the plan's succeeded originals. */
export function resumeContinuation(
  entry: ResumeEntry,
  file: WorkflowFile,
  isRoot: boolean,
): Continuation {
  return resumeFromResume(resolveResume(entry, file), file, isRoot);
}

function resumeFromResume(resume: RunResume, file: WorkflowFile, isRoot: boolean): Continuation {
  // One pairing cursor for this run's goto passes, asked in walk order.
  const resumer = passResumer(resume, file);
  return {
    disposition(node, ordinal) {
      // Iteration containers pair through `enterIteration`, never this node-id lookup.
      if (ordinal !== undefined) return { kind: "fresh" };
      const original = resume.plan.get(node.id);
      if (!original) return { kind: "fresh" };
      return {
        kind: "reuse",
        output: () => resume.input.readBlob(original, RUN_BLOB_FILE.output),
        reusedFrom: original.runId,
      };
    },
    seed() {
      return resumeSeed(resume, isRoot);
    },
    reentry: () => undefined,
    enter(key, childFile) {
      if (key.iteration !== undefined) {
        const iteration = enterIteration(
          resume,
          file,
          must(key.owner, "owner of a loop iteration").id,
          key.iteration,
        );
        return iteration ? resumeFromResume(iteration, childFile, false) : FRESH;
      }
      if (key.pass !== undefined) {
        return resumeFromResume(resumer(key.pass, key.owner?.id ?? null), childFile, false);
      }
      const nested = enterNested(resume, file, must(key.owner, "owner of a nested run").id);
      return nested ? resumeContinuation(nested, childFile, false) : FRESH;
    },
    decidedRaceWinner(node) {
      return pickReusedWaitOneWinner(node, resume.plan);
    },
    passWalk: (_gotos, seedInput) => freshPassWalk(seedInput),
  };
}

/** The Complete adapter: this same tree, replayed in place over its own cached rows. */
export function completeContinuation(
  state: ContinueState,
  file: WorkflowFile,
  rootRunId: string,
): Continuation {
  return completeFromScope(state, file, rootRunId, ownRow(state, rootRunId));
}

/** This run's own recorded row, or `undefined` for a run opened fresh inside the tree. */
function ownRow(state: ContinueState, runId: string): RunRecord | undefined {
  return state.existingRuns.find((run) => run.runId === runId);
}

function completeFromScope(
  state: ContinueState,
  file: WorkflowFile,
  parentRunId: string,
  ownRun: RunRecord | undefined,
): Continuation {
  return {
    disposition(node, ordinal) {
      // One row under this parent answers the node; more than one is a corrupt tree and runs fresh.
      const existing = recordedChild(state.existingRuns, parentRunId, {
        nodeId: node.id,
        iteration: ordinal,
      });
      if (!existing) return { kind: "fresh" };
      if (existing.status === "succeeded")
        return { kind: "reuse", output: () => readExistingOutput(state, existing) };
      if (existing.status === "awaiting") {
        return existing.runId === state.target.stepRunId
          ? { kind: "complete", runId: existing.runId, output: state.target.output }
          : { kind: "park" };
      }
      if (node.type === "workflow" || ordinal !== undefined) return { kind: "reenter", existing };
      return { kind: "fresh" };
    },
    seed: () => undefined,
    reentry() {
      if (ownRun === undefined) return undefined;
      return {
        existing: ownRun,
        context: state.readBlob(ownRun, RUN_BLOB_FILE.context) as { [key: string]: JsonValue },
      };
    },
    enter(_key, childFile, identity) {
      return completeFromScope(state, childFile, identity.runId, ownRow(state, identity.runId));
    },
    decidedRaceWinner: () => undefined,
    passWalk: (gotos, seedInput) => completePassWalk(state, file, parentRunId, gotos, seedInput),
  };
}

function freshPassWalk(seedInput: JsonValue): PassWalkStart {
  return {
    pass: 1,
    opener: null,
    start: 0,
    carried: seedInput,
    jumpsSpent: new Map(),
    reentered: undefined,
  };
}

/**
 * A Complete's pass walk (ADR 0060, spec §8.2): closed passes are facts, not re-walked, and the
 * `running` one re-enters at its opening goto's target, which must be the node it recorded first.
 */
function completePassWalk(
  state: ContinueState,
  file: WorkflowFile,
  parentRunId: string,
  gotos: ReadonlyMap<string, GotoNode>,
  seedInput: JsonValue,
): PassWalkStart | PassDivergence {
  const walk = freshPassWalk(seedInput);
  const passes = recordedPasses(state.existingRuns, parentRunId);
  for (const recorded of passes) {
    if (recorded.nodeId !== null)
      walk.jumpsSpent.set(recorded.nodeId, (walk.jumpsSpent.get(recorded.nodeId) ?? 0) + 1);
  }
  const reentered = passes.find((recorded) => recorded.status === "running");
  if (!reentered) return walk;
  walk.reentered = reentered;
  walk.pass = must(reentered.pass, "pass number of a pass run");
  walk.carried = state.readBlob(reentered, RUN_BLOB_FILE.input);
  if (walk.pass === 1) return walk;

  // Pass N starts at its opening goto's target, which must be the node the pass recorded first: a
  // different tail would no longer match the pass's rows. `existingRuns` is in start order.
  const body = file.body;
  const goto = reentered.nodeId === null ? undefined : gotos.get(reentered.nodeId);
  const target = goto && body.find((candidate) => candidate.name === goto.target);
  const recordedFirst = state.existingRuns.find((run) => run.parentRunId === reentered.runId);
  if (!goto || !target || passFirstNode(target)?.id !== recordedFirst?.nodeId) {
    return {
      diverged: reentered,
      error:
        `Complete replay diverged: pass ${walk.pass} was opened by goto "${goto?.name ?? reentered.nodeName}" ` +
        `whose target is now "${goto?.target ?? "(none)"}", recorded "${recordedFirst?.nodeName ?? "(none)"}"`,
      commit: parkedLeafUnder(state, reentered.runId),
    };
  }
  walk.opener = goto;
  walk.start = body.indexOf(target);
  return walk;
}

/** The goto target's first node in serial order — the node a pass opened at (ADR 0064). */
export function passFirstNode(target: WorkflowNode): WorkflowNode | undefined {
  return serialOrder([target])[0];
}

/** The goto pass rows recorded under one workflow-run, in ordinal order. */
export function recordedPasses(rows: readonly RunRecord[], parentRunId: string): RunRecord[] {
  return rows
    .filter((r) => r.parentRunId === parentRunId && isPassRun(r))
    .sort((a, b) => (a.pass ?? 0) - (b.pass ?? 0));
}

/** The parked target leaf, when it sits under a pass row of this tree (ADR 0060 §2). */
function parkedLeafUnder(state: ContinueState, ancestorRunId: string): ParkedLeaf | undefined {
  const path = pathToRoot(state.existingRuns, state.target.stepRunId);
  if (!path.some((run) => run.parentRunId === ancestorRunId)) return undefined;
  const leaf = must(path.at(-1), "parked leaf run");
  return {
    runId: leaf.runId,
    node: {
      id: must(leaf.nodeId, "node id of the parked leaf"),
      name: must(leaf.nodeName, "node name of the parked leaf"),
    },
    output: state.target.output,
  };
}

/**
 * The recorded output of an existing `succeeded` row; reuse rows were pre-swapped, so its own
 * `outputRef` holds it.
 */
function readExistingOutput(state: ContinueState, run: RunRecord): JsonValue {
  return run.outputRef ? state.readBlob(run, RUN_BLOB_FILE.output) : {};
}

/** The persisted denormalization of the rerun boundary path: each node id with its human name at
 * its own level. */
export function resolveRerunFromNodePath(
  rootFile: WorkflowFile,
  rootDir: string,
  files: Map<string, WorkflowFile> | undefined,
  rerunFromNodePath: string[] | undefined,
  rerunFromPasses: (number | null)[] = [],
): RerunFromNodePathEntry[] | undefined {
  if (rerunFromNodePath === undefined || rerunFromNodePath.length === 0) return undefined;
  // One descent of the nested-ref tree; a level the descent could not reach falls back to its own
  // id.
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
