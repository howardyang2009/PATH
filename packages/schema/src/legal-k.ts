import { must } from "./must.js";
import type { WorkflowNode } from "./node-type.js";
import {
  type ControlBlockKind,
  enclosingControlBlock,
  isStepType,
  serialOrder,
  walkNodes,
} from "./node-walk.js";
import { isPassRun, type RunKindFields } from "./run-kind.js";
import type { RunStatus } from "./run-status.js";
import { findRootRun, pathToRoot, type RunTreeFields } from "./run-tree.js";

/** The **legal-K** taxonomy at one descent level (spec §5, ADR 0032/0036): legal when every level
 * of the root→…→K descent is run-producing in serial order (first level or sequences only, ADR
 * 0064), the leaf's run succeeded, and the prefix before K succeeded. Owned here so engine and
 * client mirror cannot disagree. */
export type LegalKLevelReason =
  | "not-in-file" // no node with this id in this level's file (rename/move survive by id)
  // present but inside a loop / parallel / branch body (a sequence is transparent, ADR 0064)
  | "in-body"
  | "not-succeeded"
  | "prefix-unsucceeded";

/** A level classification: legal, or the first §5 reason it is not (with the enclosing controller
 * on `in-body`). */
export type LegalKLevelResult =
  | { ok: true }
  | { ok: false; reason: LegalKLevelReason; container?: ControlBlockKind };

/** The three fields the level test reads from a run row — a `RunRecord` or a client `RunNodeState`
 * fits. */
export interface LegalKLevelRun {
  parentRunId: string | null;
  nodeId: string | null;
  status: RunStatus;
}

export interface ClassifyLevelKArgs {
  /** This level's file body — the root file's body at level 0, a descended nested `workflow`'s
   * below. */
  body: WorkflowNode[];
  /** The rows the prefix rule queries; filtered to `scopeRunId`'s direct children inside. */
  rows: Iterable<LegalKLevelRun>;
  /** The run whose direct children are this level's node runs — the root run at level 0, else the
   * path-node's run. */
  scopeRunId: string | undefined;
  /** K's node id at this level. */
  nodeId: string;
  /** The leaf's own status when this is the leaf level; `null` for an intermediate path node. */
  leafStatus: RunStatus | null;
  /** Under a goto, the run ids of passes 1..N-1 whose rows the prefix rule also reads (ADR 0054
   * §6). */
  earlierPassRunIds?: readonly string[];
}

/** Classifies one descent level in §5 order (first failure wins): node locus, then the leaf's own
 * success, then the prefix's. `{ ok: true }` when this level is legal. */
export function classifyLevelK(args: ClassifyLevelKArgs): LegalKLevelResult {
  const { body, rows, scopeRunId, nodeId, leafStatus, earlierPassRunIds = [] } = args;

  // Locate the node: serial order (first level or sequences only, ADR 0064) is the only legal
  // locus.
  const order = serialOrder(body);
  const serialIndex = order.findIndex((node) => node.id === nodeId);
  if (serialIndex < 0) {
    const presentSomewhere = [...walkNodes(body)].some((node) => node.id === nodeId);
    if (!presentSomewhere) return { ok: false, reason: "not-in-file" };
    const container = enclosingControlBlock(body, nodeId);
    return container
      ? { ok: false, reason: "in-body", container }
      : { ok: false, reason: "in-body" };
  }

  // The leaf K's own run must have succeeded (a reuse row counts — it is written `succeeded`).
  if (leafStatus !== null && leafStatus !== "succeeded")
    return { ok: false, reason: "not-succeeded" };

  // Every run-producing node in the prefix <K that actually ran must have succeeded under this
  // level's scope. A descendant that produced no run was legitimately skipped and does not gate the
  // prefix; under a goto the prefix spans earlier passes, which are serialized before K whole (ADR
  // 0054 §6).
  const rowArray = [...rows];
  const prefixBroken = (scope: string | undefined, prefix: WorkflowNode[]): boolean => {
    const ranInScope = (id: string): boolean =>
      rowArray.some((r) => r.parentRunId === scope && r.nodeId === id);
    const succeededInScope = (id: string): boolean =>
      rowArray.some((r) => r.parentRunId === scope && r.nodeId === id && r.status === "succeeded");
    for (const inner of walkNodes(prefix)) {
      if (isStepType(inner.type) && ranInScope(inner.id) && !succeededInScope(inner.id))
        return true;
    }
    return false;
  };
  if (earlierPassRunIds.some((passRunId) => prefixBroken(passRunId, body)))
    return { ok: false, reason: "prefix-unsucceeded" };
  if (prefixBroken(scopeRunId, order.slice(0, serialIndex)))
    return { ok: false, reason: "prefix-unsucceeded" };

  return { ok: true };
}

/** The fields the boundary-level walk reads from a run row — a `RunRecord` or a client
 * `RunNodeState` fits. */
export interface BoundaryLevelRun extends RunTreeFields, Pick<RunKindFields, "pass"> {
  nodeId: string | null;
}

/** One level of the root→…→K descent: the path-node's run, its goto pass (ADR 0054 §6), the scope
 * `classifyLevelK` reads, and the earlier passes of the same workflow-run. */
export interface BoundaryLevel<T extends BoundaryLevelRun> {
  run: T;
  passRun: (T & { pass: number }) | undefined;
  scopeRunId: string | undefined;
  earlierPassRunIds: string[];
}

/** The descent levels root→…→`selectedRunId`, top-down, the root run excluded. A goto pass row on
 * the chain folds into the level below as that level's pass; `[]` when the id is not in `rows` or
 * is the root. */
export function boundaryLevels<T extends BoundaryLevelRun>(
  rows: Iterable<T>,
  selectedRunId: string,
): BoundaryLevel<T>[] {
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
      ? all
          .filter((r) => r.parentRunId === scopeRunId && isPassRun(r) && r.pass < pass.pass)
          .map((r) => r.runId)
      : [];
    levels.push({ run, passRun: pass, scopeRunId: pass?.runId ?? scopeRunId, earlierPassRunIds });
    scopeRunId = run.runId;
    passRun = undefined;
  }
  return levels;
}

/** What a selected run is. Only a node's run can be a boundary — the root run owns no node, and a
 * goto pass is a container, not a node (ADR 0054 §3). A `node` selection carries its descent
 * levels. */
export type BoundarySelection<T extends BoundaryLevelRun> =
  | { kind: "not-in-tree" }
  | { kind: "pass-run"; pass: number }
  | { kind: "root-run" }
  | { kind: "node"; run: T & { nodeId: string }; levels: BoundaryLevel<T>[] };

/** Classifies `selectedRunId` among `rows` before any level is classified; engine and client mirror
 * both start here, so neither can accept a selection the other refuses. */
export function selectBoundary<T extends BoundaryLevelRun>(
  rows: Iterable<T>,
  selectedRunId: string,
): BoundarySelection<T> {
  const all = [...rows];
  const selected = all.find((r) => r.runId === selectedRunId);
  if (!selected) return { kind: "not-in-tree" };
  if (isPassRun(selected)) return { kind: "pass-run", pass: selected.pass };
  if (selected.parentRunId === null || selected.nodeId === null) return { kind: "root-run" };
  return {
    kind: "node",
    run: selected as T & { nodeId: string },
    levels: boundaryLevels(all, selectedRunId),
  };
}

// ── The whole verdict ───────────────────────────────────────────────────────────────────────────

/** Why a selected run cannot be the rerun boundary (K): the §5 taxonomy's reasons, the three
 * selection facts, and the two ways a nested `ref` can stop the descent. One union for every door,
 * so a new reason is a compile error in each of them. */
export type LegalKBoundaryReason =
  /** The run id names no row of the source tree. */
  | "not-in-tree"
  /** The root run owns no node (invariant 2). */
  | "root-run"
  /** A goto pass is a container, not a node (ADR 0054 §3). */
  | "pass-run"
  | LegalKLevelReason
  /** An intermediate path node is no longer a nested `workflow` to descend into. */
  | "not-workflow"
  /** Its `ref` names a file the loaded tree does not hold. */
  | "ref-unresolved";

/** A refused K, as data: what went wrong, and the facts a door needs to word it its own way. */
export interface LegalKBoundaryRefusal {
  reason: LegalKBoundaryReason;
  /** The selected run id, verbatim. */
  runId: string;
  /** The offending node's human name, on the reasons that name one. */
  nodeName?: string;
  /** The goto pass's 1-based ordinal, on `pass-run`. */
  pass?: number;
  /** The innermost enclosing controller, on `in-body`. */
  container?: ControlBlockKind;
  /** The intermediate node's `ref`, on `ref-unresolved`. */
  ref?: string;
}

/** The fields the whole verdict reads from a run row: the boundary-level tree and kind facts, plus
 * the status and human name a node-level reason names. A `RunRecord` or a client `RunNodeState`
 * fits. */
export interface LegalKBoundaryRun extends BoundaryLevelRun, LegalKLevelRun {
  nodeName: string | null;
}

/** A legal K: the node-id descent path root→…→K and, level for level, the goto pass each path-node
 * sits in (ADR 0054 §6), `null` where the file holds no goto; or the one reason it is refused. */
export type LegalKBoundary<T extends LegalKBoundaryRun> =
  | { ok: true; nodePath: string[]; passes: (number | null)[]; nodeName: string; run: T }
  | { ok: false; refusal: LegalKBoundaryRefusal };

/**
 * How much of the root→…→K descent the caller can see: one file body per path level, and where a
 * nested `ref` stopped it. The engine descends its loaded ref tree and passes every level it
 * reached; a surface that holds only the root file passes that one body, and a level past the end is
 * judged on its own run status alone — the honest difference between a door with the file tree and
 * one without it.
 */
export interface LegalKScope {
  bodies: readonly (readonly WorkflowNode[])[];
  /** Where the descent stopped, when it did: the level index and which miss it was. */
  stoppedAt?: { index: number; reason: "not-workflow" | "ref-unresolved" };
}

/**
 * The one legal-K verdict (spec §5, ADR 0032/0036/0054/0064): classify the selection, then each
 * level of the descent in order — locus in serial order, the leaf's own success, the prefix's —
 * under the scope the caller can see. Doors map a refusal's `reason` to their own transport and
 * wording; none of them re-derives the order.
 */
export function legalKBoundary<T extends LegalKBoundaryRun>(
  rows: Iterable<T>,
  selectedRunId: string,
  scope: LegalKScope,
): LegalKBoundary<T> {
  // One read of the rows: an iterable may be single-use, and the selection, the level test and the
  // prefix all query them.
  const all = [...rows];
  const selection = selectBoundary(all, selectedRunId);
  if (selection.kind === "not-in-tree")
    return refused({ reason: "not-in-tree", runId: selectedRunId });
  if (selection.kind === "pass-run")
    return refused({ reason: "pass-run", runId: selectedRunId, pass: selection.pass });
  if (selection.kind === "root-run") return refused({ reason: "root-run", runId: selectedRunId });

  const { run, levels } = selection;
  const nodePath = levels.map((level) => must(level.run.nodeId, "node id of a boundary level"));
  const passes = levels.map((level) => level.passRun?.pass ?? null);
  const nodeName = run.nodeName ?? run.nodeId;

  for (const [level, entry] of levels.entries()) {
    const nodeId = must(entry.run.nodeId, "node id of a boundary level");
    const label = entry.run.nodeName ?? nodeId;
    const isLeaf = level === levels.length - 1;
    const body = scope.bodies[level];

    // Past the caller's reach: only the leaf's own status is knowable, and it must have succeeded.
    if (body === undefined) {
      if (isLeaf && entry.run.status !== "succeeded")
        return refused({ reason: "not-succeeded", runId: selectedRunId, nodeName: label });
      continue;
    }

    const levelResult = classifyLevelK({
      body: [...body],
      rows: all,
      scopeRunId: entry.scopeRunId,
      nodeId,
      leafStatus: isLeaf ? entry.run.status : null,
      earlierPassRunIds: entry.earlierPassRunIds,
    });
    if (!levelResult.ok) {
      return refused({
        reason: levelResult.reason,
        runId: selectedRunId,
        nodeName: label,
        ...(levelResult.container ? { container: levelResult.container } : {}),
      });
    }

    // An intermediate node must still be a nested `workflow` whose `ref` resolves; the descent says
    // which of the two failed.
    const stopped = scope.stoppedAt;
    if (!isLeaf && stopped?.index === level) {
      const node = serialOrder([...body]).find((candidate) => candidate.id === nodeId);
      const ref = node && node.type === "workflow" ? node.ref : undefined;
      return refused({
        reason: stopped.reason,
        runId: selectedRunId,
        nodeName: label,
        ...(ref === undefined ? {} : { ref }),
      });
    }
  }

  return { ok: true, nodePath, passes, nodeName, run };
}

function refused(refusal: LegalKBoundaryRefusal): { ok: false; refusal: LegalKBoundaryRefusal } {
  return { ok: false, refusal };
}
