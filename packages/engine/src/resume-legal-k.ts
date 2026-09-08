import { walkNodes, type RunRecord, type WorkflowFile } from "@path/schema";
import { RUN_PRODUCING_TYPES } from "./plan-reuse.js";

/**
 * The **legal-K** authority for Resume-from-chosen-K (spec §5, ADR 0032). One shared predicate,
 * consulted at one place (`Project.resume`), that resolves the operator's **source run id** to the
 * **rerun boundary (K)** node-id path and validates it against the current file — so a `--from` value
 * and the future `--list-eligible` verdict can never disagree.
 *
 * This ticket resolves only a **top-level K** (a top-level node of the root file); a nested K is
 * #TBD-T2. The refusal taxonomy is checked in dependency order, first failure wins (spec §5):
 *
 *   1. run id in no run of the source tree               — 400
 *   2. resolves to a since-deleted node                  — 409
 *   3. illegal locus (inside a loop/parallel/branch body) — 400
 *   4. K node not succeeded                              — 409
 *   5. prefix `<K` not fully succeeded                   — 409
 *
 * 400 = an unresolvable or unsupported selection; 409 = a state or file-divergence conflict. The
 * message is the one wording authority — the CLI prints it verbatim, and the Designer/listing render
 * the same taxonomy — so it must read on its own.
 */
export interface LegalKRefusal {
  status: number;
  message: string;
}

export type LegalKResult =
  | { ok: true; nodePath: string[] }
  | { ok: false; refusal: LegalKRefusal };

function refuse(status: number, message: string): LegalKResult {
  return { ok: false, refusal: { status, message } };
}

/**
 * Resolve `runId` against the source tree `sourceRows` (the predecessor tree's own rows, reuse rows
 * included) and the current `rootFile`, returning the top-level rerun-boundary node-id path on
 * success or a taxonomy refusal. `sourceRows` must be the raw predecessor tree (not the reuse-swapped
 * plan input): the operator selected a run of *that* tree, and its recorded status is what reason #4
 * reads.
 */
export function resolveLegalK(rootFile: WorkflowFile, sourceRows: RunRecord[], runId: string): LegalKResult {
  // 1. The run id must name a run of the source tree.
  const row = sourceRows.find((r) => r.runId === runId);
  if (!row) {
    return refuse(400, `run id "${runId}" is not in the run tree being resumed`);
  }

  // The root run is never a rerun boundary (it owns no node — a top-level workflow-step, invariant 2).
  // A succeeded root run's only resume is plain Resume, not Resume-from-K.
  if (row.parentRunId === null || row.nodeId === null) {
    return refuse(400, `run "${runId}" is the root run, which is never a rerun boundary`);
  }
  const nodeId = row.nodeId;
  const label = row.nodeName ?? nodeId;

  // Locate the node in the current file. A top-level, run-producing node is the only legal locus for
  // this ticket; anything else splits into the since-deleted (#2) and illegal-locus (#3) reasons.
  const topLevelIndex = rootFile.body.findIndex((node) => node.id === nodeId);
  if (topLevelIndex < 0) {
    const presentSomewhere = [...walkNodes(rootFile.body)].some((node) => node.id === nodeId);
    // 2. Resolves to a node no longer in the workflow (renamed/moved survive by id; a delete fails).
    if (!presentSomewhere) {
      return refuse(409, `run "${runId}" resolves to node "${label}", which is no longer in the workflow`);
    }
    // 3. Present, but nested inside a loop / parallel / branch body — an illegal K locus (out of
    // scope, per-iteration identity; #427). A nested `workflow` node is the nested-K case (#TBD-T2),
    // which this top-level slice also refuses here.
    return refuse(
      400,
      `run "${runId}" resolves to node "${label}", which is inside a loop, parallel, or branch body and cannot be a rerun boundary`,
    );
  }

  // 4. K itself must have succeeded (a reuse row counts — it is written `succeeded`).
  if (row.status !== "succeeded") {
    return refuse(409, `run "${runId}" (node "${label}") did not succeed; a rerun boundary must be a succeeded node`);
  }

  // 5. The whole prefix `<K` must have succeeded, so it can be reused. A top-level control node owns
  // no run row of its own, so its success is that of its run-producing descendants — checked against
  // the source root run's own children (a top-level node's runs scope directly under the root run).
  // A prefix `while-do` whose body ran many times passes on *any* succeeded iteration row for a body
  // id — the same multi-iteration reuse limit plain Resume has (spec §4: "neither fixed nor
  // worsened"), inherited here rather than a new gap.
  const rootRow = sourceRows.find((r) => r.parentRunId === null);
  const rootRunId = rootRow?.runId;
  const succeededAtRoot = (id: string): boolean =>
    sourceRows.some((r) => r.parentRunId === rootRunId && r.nodeId === id && r.status === "succeeded");
  for (const prefixNode of rootFile.body.slice(0, topLevelIndex)) {
    for (const inner of walkNodes([prefixNode])) {
      if (!RUN_PRODUCING_TYPES.has(inner.type)) continue;
      if (!succeededAtRoot(inner.id)) {
        return refuse(
          409,
          `run "${runId}" (node "${label}") has an unsucceeded node before it; the whole prefix must succeed to reuse it`,
        );
      }
    }
  }

  return { ok: true, nodePath: [nodeId] };
}
