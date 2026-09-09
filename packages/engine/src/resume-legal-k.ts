import { dirname, resolve } from "node:path";
import {
  classifyLevelK,
  type ControlBlockKind,
  type LegalKLevelReason,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";

/**
 * The **legal-K** authority for Resume-from-chosen-K (spec §5, ADR 0032/0036). One shared predicate,
 * consulted at one place (`Project.resume`), that resolves the operator's **source run id** to the
 * **rerun boundary (K)** node-id descent path and validates it against the current file — so a `--from`
 * value and the `--list-eligible` verdict can never disagree.
 *
 * K may be a **top-level node of the root file** (a length-1 path, ADR 0035) or a node inside a nested
 * `workflow` file, reached by a descent path root→…→K (ADR 0036). The path is resolved by walking the
 * source run's `parentRunId` chain to root; each on-path level is validated against its own file. The
 * refusal taxonomy is checked in dependency order, first failure wins (spec §5):
 *
 *   1. run id in no run of the source tree               — 400
 *   2. resolves to a since-deleted node                  — 409
 *   3. illegal locus (inside a loop/parallel/branch body) — 400
 *   4. K node not succeeded                              — 409
 *   5. prefix `<K` not fully succeeded                   — 409
 *
 * 400 = an unresolvable or unsupported selection; 409 = a state or file-divergence conflict. Reasons 2,
 * 3 and 5 are checked **at every level** of the descent (a since-moved intermediate `workflow` node, or
 * an unsucceeded prefix one level down, refuses the whole selection); reason 4 gates the leaf K, since
 * an intermediate path-node is descended and re-run, not reused, so its own status is not required. The
 * message is the one wording authority — the CLI prints it verbatim, and the Designer/listing render
 * the same taxonomy — so it must read on its own.
 */
/**
 * The §5 taxonomy classification of a refusal, for a surface that renders its own short reason rather
 * than the verbatim `message` — the `--list-eligible` listing's `eligible?` column (spec §6), whose
 * cell vocabulary is 1:1 with this set. `--from` renders `message` and ignores this. Exposing the
 * classification (rather than re-deriving it from the message text) keeps the one authority: the
 * predicate that decides eligible/ineligible also names *why*, so the listing can never disagree.
 */
export type LegalKReasonCode =
  | "not-in-tree" // #1 — the run id names no run of the source tree (never fires on a listed row)
  | "root-run" // the root row; the implicit root step is never a K
  | LegalKLevelReason; // #2–#5, the per-level taxonomy shared with the client's eager mirror (`classifyLevelK`)

/**
 * The innermost enclosing logicer named in an `in-body` refusal (spec §6): `loop` is `while-do`. The
 * locus vocabulary and its lookup now live in `@path/schema` (`enclosingControlBlock`), shared with the
 * client's eager mirror; this alias keeps the taxonomy's own name for the engine's readers.
 */
export type LegalKContainer = ControlBlockKind;

export interface LegalKRefusal {
  status: number;
  message: string;
  /** The §5 taxonomy classification (spec §6). See {@link LegalKReasonCode}. */
  reason: LegalKReasonCode;
  /** Only on `reason: "in-body"`: the innermost enclosing logicer, so the listing can name it. */
  container?: LegalKContainer;
}

export type LegalKResult =
  | { ok: true; nodePath: string[] }
  | { ok: false; refusal: LegalKRefusal };

function refuse(status: number, message: string, reason: LegalKReasonCode, container?: LegalKContainer): LegalKResult {
  return { ok: false, refusal: container ? { status, message, reason, container } : { status, message, reason } };
}

/**
 * Resolve `runId` against the source tree `sourceRows` (the predecessor tree's own rows, reuse rows
 * included), the current `rootFile`, and the loaded file tree (`files` keyed by absolute path, resolved
 * from `rootDir` for the descent), returning the rerun-boundary node-id path on success or a taxonomy
 * refusal. `sourceRows` must be the raw predecessor tree (not the reuse-swapped plan input): the
 * operator selected a run of *that* tree, and its recorded status is what reasons #4/#5 read. `files`
 * and `rootDir` are consulted only when the path descends (a nested K); a top-level K never reads them.
 */
export function resolveLegalK(
  rootFile: WorkflowFile,
  sourceRows: RunRecord[],
  runId: string,
  files: Map<string, WorkflowFile>,
  rootDir: string,
): LegalKResult {
  // 1. The run id must name a run of the source tree.
  const byRunId = new Map(sourceRows.map((r) => [r.runId, r]));
  const selected = byRunId.get(runId);
  if (!selected) {
    return refuse(400, `run id "${runId}" is not in the run tree being resumed`, "not-in-tree");
  }

  // The root run is never a rerun boundary (it owns no node — a top-level workflow-step, invariant 2).
  // A succeeded root run's only resume is plain Resume, not Resume-from-K.
  if (selected.parentRunId === null || selected.nodeId === null) {
    return refuse(400, `run "${runId}" is the root run, which is never a rerun boundary`, "root-run");
  }

  // The descent path of runs root→…→K, top-down (root excluded): walk the selected run's parents up
  // to the null-parent root. Each run's `nodeId` is the path-node at its level; its parent's run is
  // the scope the level's prefix succeeded under. `getRunsForRoot` gives one whole tree, so every
  // `parentRunId` resolves and the walk always reaches the root.
  const chain: RunRecord[] = [];
  let cursor: RunRecord | undefined = selected;
  while (cursor && cursor.parentRunId !== null) {
    chain.unshift(cursor);
    cursor = byRunId.get(cursor.parentRunId);
  }
  const rootRun = sourceRows.find((r) => r.parentRunId === null);

  // Walk the levels top-down, descending the current file tree alongside the run chain. `scopeRunId`
  // is the run whose direct children are this level's nodes: the root run at level 0, then each
  // descended path-node's own run.
  let curFile = rootFile;
  let curDir = rootDir;
  let scopeRunId = rootRun?.runId;
  const nodePath: string[] = [];

  for (let level = 0; level < chain.length; level++) {
    const pathRun = chain[level]!;
    const nodeId = pathRun.nodeId!; // non-null: the chain excludes the root run
    const label = pathRun.nodeName ?? nodeId;
    const isLeaf = level === chain.length - 1;
    nodePath.push(nodeId);

    // The per-level §5 taxonomy — locate (#2/#3), the leaf's own success (#4), the prefix's success
    // (#5) — is the one predicate shared with the client's eager mirror (`@path/schema/classifyLevelK`,
    // ADR 0032/0036). Only the leaf level gates its own status; an intermediate path-node is descended
    // and re-run, not reused. The engine owns the descent, the HTTP status, and the verbatim message;
    // the reason code it returns is this taxonomy. `#427`: an in-body locus names its enclosing logicer.
    const levelResult = classifyLevelK({
      body: curFile.body,
      rows: sourceRows,
      scopeRunId,
      nodeId,
      leafStatus: isLeaf ? pathRun.status : null,
    });
    if (!levelResult.ok) {
      switch (levelResult.reason) {
        case "not-in-file":
          return refuse(409, `run "${runId}" resolves to node "${label}", which is no longer in the workflow`, "not-in-file");
        case "in-body":
          return refuse(
            400,
            `run "${runId}" resolves to node "${label}", which is inside a loop, parallel, or branch body and cannot be a rerun boundary`,
            "in-body",
            levelResult.container,
          );
        case "not-succeeded":
          return refuse(
            409,
            `run "${runId}" (node "${label}") did not succeed; a rerun boundary must be a succeeded node`,
            "not-succeeded",
          );
        case "prefix-unsucceeded":
          return refuse(
            409,
            `run "${runId}" (node "${label}") has an unsucceeded node before it; the whole prefix must succeed to reuse it`,
            "prefix-unsucceeded",
          );
      }
    }
    const node = curFile.body.find((n) => n.id === nodeId)!;

    if (!isLeaf) {
      // An intermediate path-node is descended into, so it must still be a nested `workflow` node whose
      // ref resolves to a loaded file. A type change or a since-removed ref is a file divergence (#2).
      if (node.type !== "workflow") {
        return refuse(
          409,
          `run "${runId}" resolves through node "${label}", which is no longer a nested workflow and cannot be descended`,
          "not-in-file",
        );
      }
      const childPath = resolve(curDir, node.ref);
      const childFile = files.get(childPath);
      if (!childFile) {
        return refuse(
          409,
          `run "${runId}" resolves through node "${label}", whose referenced file "${node.ref}" is no longer in the workflow`,
          "not-in-file",
        );
      }
      curFile = childFile;
      curDir = dirname(childPath);
      scopeRunId = pathRun.runId;
    }
  }

  return { ok: true, nodePath };
}
