import { enclosingControlBlock, isStepType, serialOrder, walkNodes, type ControlBlockKind } from "./node-walk.js";
import type { WorkflowNode } from "./node-type.js";
import type { RunStatus } from "./run-status.js";
import { isPassRun, type RunKindFields } from "./run-kind.js";
import { findRootRun, pathToRoot, type RunTreeFields } from "./run-tree.js";

/**
 * The **legal-K** taxonomy, at the grain of one descent level, as a shared primitive (spec §5, ADR
 * 0032/0036). A rerun boundary (K) is legal when, at every level of its root→…→K descent, the node is
 * a run-producing node in the serial order of that level's file (first level, or inside sequences only,
 * ADR 0064), the leaf K's own run succeeded, and the prefix
 * before K succeeded. Those per-level reasons — since-deleted (#2), inside-a-body (#3), the leaf's own
 * success (#4), the prefix's success (#5) — used to be spelled twice: once in the engine's authority
 * (`resolveLegalK`) and once in the client's eager Designer mirror (`resumeFromEligibility`), kept
 * equal only by hand. This owns the classification once; each surface keeps only its own wrapper — the
 * engine adds #1/root-run, the HTTP status and the verbatim message; the client adds no-selection and
 * the dirty-buffer save gate. The two callers make the seam real, and the taxonomy can no longer
 * disagree with itself.
 *
 * It stays deliberately low: it classifies **one level** against **one file body** and the rows under
 * one scope. The engine drives it once per level of a nested descent; the client drives it once, for a
 * top-level K in the open root file (the only level a browser holds). Root detection, the descent walk,
 * and message wording sit on top of it, not inside it.
 */
export type LegalKLevelReason =
  | "not-in-file" // #2 — resolves to a node no longer in this level's file (rename/move survive by id)
  | "in-body" // #3 — present, but inside a loop / parallel / branch body (a sequence is transparent, ADR 0064)
  | "not-succeeded" // #4 — the leaf K's own run did not reach `succeeded`
  | "prefix-unsucceeded"; // #5 — a node before K at K's level ran and did not succeed

/** A level classification: legal, or the first §5 reason it is not (with the enclosing controller on `in-body`). */
export type LegalKLevelResult =
  | { ok: true }
  | { ok: false; reason: LegalKLevelReason; container?: ControlBlockKind };

/** The three fields the level test reads from a run row — a `RunRecord` or a client `RunNodeState` fits. */
export interface LegalKLevelRun {
  parentRunId: string | null;
  nodeId: string | null;
  status: RunStatus;
}

export interface ClassifyLevelKArgs {
  /** This level's file body — the root file's body at level 0, a descended nested `workflow`'s below. */
  body: WorkflowNode[];
  /** The rows the prefix rule (#5) queries; filtered to `scopeRunId`'s direct children inside. */
  rows: Iterable<LegalKLevelRun>;
  /** The run whose direct children are this level's node runs — the root run at level 0, else the path-node's run. */
  scopeRunId: string | undefined;
  /** K's node id at this level. */
  nodeId: string;
  /**
   * The selected leaf run's own status when this is the leaf level (gates #4); `null` for an
   * intermediate path node, which is descended and re-run, not reused, so its own status is not gated.
   */
  leafStatus: RunStatus | null;
  /**
   * The earlier passes of this level, when K sits in pass N of a file holding a goto (ADR 0054 §6): the
   * run ids of passes 1 to N-1, each a scope whose rows the prefix rule (#5) also reads. Every node
   * those passes ran is serialized before K, so the prefix is counted across passes. Absent or empty
   * for a goto-free level, or for K in pass 1.
   */
  earlierPassRunIds?: readonly string[];
}

/**
 * Classify one descent level of a legal-K path, in the engine's §5 dependency order (first failure
 * wins): locate the node (#2 since-deleted, #3 illegal locus), then the leaf's own success (#4), then
 * the prefix's success (#5). `{ ok: true }` when this level is legal.
 */
export function classifyLevelK(args: ClassifyLevelKArgs): LegalKLevelResult {
  const { body, rows, scopeRunId, nodeId, leafStatus, earlierPassRunIds = [] } = args;

  // #2 / #3 — locate the node at this level. A node in the body's serial order (first level, or inside
  // sequences only, ADR 0064) is the only legal locus; anything else splits into since-deleted (#2) and
  // illegal-locus (#3).
  const order = serialOrder(body);
  const serialIndex = order.findIndex((node) => node.id === nodeId);
  if (serialIndex < 0) {
    const presentSomewhere = [...walkNodes(body)].some((node) => node.id === nodeId);
    if (!presentSomewhere) return { ok: false, reason: "not-in-file" };
    const container = enclosingControlBlock(body, nodeId);
    return container ? { ok: false, reason: "in-body", container } : { ok: false, reason: "in-body" };
  }

  // #4 — the leaf K's own run must have succeeded (a reuse row counts — it is written `succeeded`).
  // Only the leaf level is gated: an intermediate path-node is descended and re-run, not reused.
  if (leafStatus !== null && leafStatus !== "succeeded") return { ok: false, reason: "not-succeeded" };

  // #5 — every run-producing node in the prefix `<K` that actually ran must have a succeeded run under
  // this level's scope, so it can be reused. A descendant that produced no run under scope was
  // legitimately skipped (an untaken branch arm, a zero-iteration `while-do` body) and does not gate
  // the prefix; only a ran-but-unsucceeded one breaks reuse. A `while-do` body that ran many times
  // passes on any succeeded iteration row, the same multi-iteration reuse limit plain Resume has.
  // Under a goto the prefix is counted across passes (ADR 0054 §6): an earlier pass is serialized
  // before K whole, so every node of the body is its prefix there, not only the nodes before K.
  const rowArray = [...rows];
  const prefixBroken = (scope: string | undefined, prefix: WorkflowNode[]): boolean => {
    const ranInScope = (id: string): boolean => rowArray.some((r) => r.parentRunId === scope && r.nodeId === id);
    const succeededInScope = (id: string): boolean =>
      rowArray.some((r) => r.parentRunId === scope && r.nodeId === id && r.status === "succeeded");
    for (const inner of walkNodes(prefix)) {
      if (isStepType(inner.type) && ranInScope(inner.id) && !succeededInScope(inner.id)) return true;
    }
    return false;
  };
  if (earlierPassRunIds.some((passRunId) => prefixBroken(passRunId, body))) return { ok: false, reason: "prefix-unsucceeded" };
  if (prefixBroken(scopeRunId, order.slice(0, serialIndex))) return { ok: false, reason: "prefix-unsucceeded" };

  return { ok: true };
}

/** The fields the boundary-level walk reads from a run row — a `RunRecord` or a client `RunNodeState` fits. */
export interface BoundaryLevelRun extends RunTreeFields, Pick<RunKindFields, "pass"> {
  nodeId: string | null;
}

/**
 * One level of the root→…→K descent, as the run tree records it: the path-node's own run, the goto pass
 * it ran in (ADR 0054 §6, `undefined` for a goto-free level) and the scope `classifyLevelK` reads —
 * `scopeRunId` (the pass run under a goto, else the run whose direct children are this level's nodes)
 * and `earlierPassRunIds` (passes 1 to N-1 of the same workflow-run, the prefix counted across passes).
 */
export interface BoundaryLevel<T extends BoundaryLevelRun> {
  run: T;
  passRun: (T & { pass: number }) | undefined;
  scopeRunId: string | undefined;
  earlierPassRunIds: string[];
}

/**
 * The descent levels root→…→`selectedRunId`, top-down (the root run excluded), read from the run tree
 * alone. A goto pass row on the chain is not a level of its own: it is folded into the level below it as
 * that level's pass. The engine authority (`resolveLegalK`) classifies every level; the client mirror
 * holds only the root file, so it classifies a one-level result and backstops deeper ones to the engine.
 * `[]` when `selectedRunId` is not in `rows` or is the root run.
 */
export function boundaryLevels<T extends BoundaryLevelRun>(rows: Iterable<T>, selectedRunId: string): BoundaryLevel<T>[] {
  const all = [...rows];
  const levels: BoundaryLevel<T>[] = [];
  let scopeRunId = findRootRun(all)?.runId;
  let passRun: (T & { pass: number }) | undefined;
  for (const run of pathToRoot(all, selectedRunId).slice(1)) {
    if (isPassRun(run)) {
      passRun = run;
      continue;
    }
    const pass = passRun;
    const earlierPassRunIds = pass
      ? all.filter((r) => r.parentRunId === scopeRunId && isPassRun(r) && r.pass < pass.pass).map((r) => r.runId)
      : [];
    levels.push({ run, passRun: pass, scopeRunId: pass?.runId ?? scopeRunId, earlierPassRunIds });
    scopeRunId = run.runId;
    passRun = undefined;
  }
  return levels;
}
