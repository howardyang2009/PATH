import {
  enclosingControlBlock,
  isRootRun,
  RUN_PRODUCING_TYPES,
  walkNodes,
  type ControlBlockKind,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";

/**
 * The Designer's `Resume from …` button computes K's eligibility **eagerly** from data it already
 * holds — the run tree and the open file's body — so an illegal pick greys the button before any
 * round-trip (spec § Resume from here, ADR 0033). This is the client half of the one legal-K rule the
 * engine owns (`resume-legal-k.ts`): the engine's `refusal` stays the authority for a **race** (the
 * on-disk file moved under the buffer), and this check mirrors that rule for every state it can prove
 * from the run tree + the open **root** file.
 *
 * The mirror is exact at the **root level** — a top-level K is located in the open file's body, so
 * since-deleted (#2), inside-a-body (#3), the leaf's own success (#4), and the prefix's success (#5)
 * are all decided here, in the engine's taxonomy order. A **nested** K (a run below the root run) sits
 * in a nested `workflow` file the Designer does not hold, so only the run-tree-derivable reasons
 * (root-run, and the leaf's own success) grey it eagerly; a nested since-deleted / in-body / prefix
 * failure is left to the engine's `refusal` on click, the documented backstop for what the client
 * cannot see.
 *
 * The taxonomy reasons are 1:1 with the engine's `LegalKReasonCode`, minus `not-in-tree` (the
 * selection is always a row of the tree it came from) and plus the two surface-only states the button
 * layers on: `no-selection` (spec #1, folding the root row in) and `dirty-buffer` (spec #3).
 */
export type ResumeFromReasonCode =
  | "no-selection" // spec #1 — nothing selected, or the root row (never a K)
  | "not-in-file" // engine #2 — resolves to a since-deleted node
  | "in-body" // engine #3 — inside a loop / parallel / branch body
  | "not-succeeded" // engine #4 — the selected node did not succeed
  | "prefix-unsucceeded" // engine #5 — a node before K did not succeed
  | "dirty-buffer"; // spec #3 — a legal K, but the open file is not saved

/** The innermost enclosing logicer named in an `in-body` reason (`loop` is `while-do`), as the engine. */
export type ResumeFromContainer = ControlBlockKind;

export type ResumeFromEligibility =
  | { ok: true; runId: string; nodeName: string; shortRunId: string }
  | { ok: false; reason: ResumeFromReasonCode; message: string; container?: ResumeFromContainer };

export interface ResumeFromEligibilityArgs {
  rootRunId: string;
  /** The watched run's tree, keyed by run id — the same map the run tree renders. */
  runs: ReadonlyMap<string, RunRecord>;
  /** The open buffer's parsed file (the root level), or `null` when nothing is open. */
  rootFile: WorkflowFile | null;
  /** The run selected in the middle run tree; `null` when nothing (or the root row) is selected. */
  selectedRunId: string | null;
  /** The open buffer's dirty flag — the same save-first gate Launch uses (ADR 0030). */
  dirty: boolean;
}

/** The short run id shown in the button label; the full id is the wire value and the hover title. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/**
 * How node `id`'s runs directly under `scopeRunId` stand, for the prefix-reuse rule (#5), mirroring the
 * engine's `resolve-legal-k.ts`:
 *  - `succeeded` — at least one succeeded run. A reuse row counts (it is recorded `succeeded`), and a
 *    `while-do` body that ran many times passes on any succeeded iteration row, the same
 *    multi-iteration reuse limit plain Resume has.
 *  - `skipped` — no run at all under scope: an untaken branch arm, or a zero-iteration `while-do` body.
 *    K does not depend on it, so it does not gate the prefix.
 *  - `unsucceeded` — it ran but no run succeeded, which breaks reuse.
 */
function scopeRunState(runs: Iterable<RunRecord>, scopeRunId: string, id: string): "succeeded" | "skipped" | "unsucceeded" {
  let ran = false;
  for (const run of runs) {
    if (run.parentRunId !== scopeRunId || run.nodeId !== id) continue;
    if (run.status === "succeeded") return "succeeded";
    ran = true;
  }
  return ran ? "unsucceeded" : "skipped";
}

/**
 * Compute the button's one state: enabled (`ok: true`, carrying the label parts) or disabled with the
 * single highest-precedence reason. Precedence (spec § Resume from here): (1) no node selected, then
 * (2) an illegal K in the engine's taxonomy order, then (3) a legal K over a dirty buffer.
 */
export function resumeFromEligibility(args: ResumeFromEligibilityArgs): ResumeFromEligibility {
  const { rootRunId, runs, rootFile, selectedRunId, dirty } = args;

  // (1) Nothing selected — the button's rest state. Selecting the root row folds in here: the root run
  // owns no node (an implicit root step), so it is never a K, and its only resume is plain Resume run.
  if (selectedRunId === null) return noSelection();
  const selected = runs.get(selectedRunId);
  if (!selected || isRootRun(selected) || selected.nodeId === null) return noSelection();

  // (2) An illegal K. A top-level K (a direct child of the root run) is located in the open file's body
  // — the exact engine mirror. A nested K sits in a file the Designer does not hold, so only its own
  // success is checked here and the engine backstops the rest.
  const nodeName = selected.nodeName ?? selected.nodeId;
  if (selected.parentRunId === rootRunId && rootFile !== null) {
    const illegal = classifyTopLevel(rootFile, runs, rootRunId, selected, nodeName);
    if (illegal) return illegal;
  } else if (selected.status !== "succeeded") {
    // A nested K whose own run did not succeed is illegal on any level (engine #4); the engine owns the
    // nested since-deleted / in-body / prefix reasons this client cannot see.
    return { ok: false, reason: "not-succeeded", message: `“${nodeName}” did not succeed.` };
  }

  // (3) A legal K, but the open file is unsaved — Launch's save-first affordance. Last in precedence:
  // the reason only surfaces once the selection itself is a legal boundary.
  if (dirty) {
    return { ok: false, reason: "dirty-buffer", message: "Save to enable." };
  }

  return { ok: true, runId: selected.runId, nodeName, shortRunId: shortRunId(selected.runId) };
}

function noSelection(): ResumeFromEligibility {
  return { ok: false, reason: "no-selection", message: "Select a node in the run tree." };
}

/**
 * The root-level taxonomy check, in the engine's order: locate the node (#2 since-deleted, #3 in-body),
 * then the leaf's own success (#4), then the prefix's success (#5). Returns the first illegal reason,
 * or `null` when the top-level K is legal.
 */
function classifyTopLevel(
  rootFile: WorkflowFile,
  runs: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
  selected: RunRecord,
  nodeName: string,
): Extract<ResumeFromEligibility, { ok: false }> | null {
  const nodeId = selected.nodeId!;
  const topLevelIndex = rootFile.body.findIndex((node) => node.id === nodeId);
  if (topLevelIndex < 0) {
    const presentSomewhere = [...walkNodes(rootFile.body)].some((node) => node.id === nodeId);
    // #2 — the node was deleted from the file (a rename/move survives by id).
    if (!presentSomewhere) {
      return { ok: false, reason: "not-in-file", message: `“${nodeName}” is no longer in the workflow.` };
    }
    // #3 — present, but nested inside a control body: an illegal K locus.
    const container = enclosingControlBlock(rootFile.body, nodeId);
    return {
      ok: false,
      reason: "in-body",
      message: `“${nodeName}” is inside a ${container ?? "loop, parallel, or branch"} body and cannot be a rerun boundary.`,
      ...(container ? { container } : {}),
    };
  }

  // #4 — the leaf K's own run must have succeeded (a reuse row is recorded `succeeded`).
  if (selected.status !== "succeeded") {
    return { ok: false, reason: "not-succeeded", message: `“${nodeName}” did not succeed.` };
  }

  // #5 — every run-producing node in the prefix `<K` that actually ran must have a succeeded run under
  // the root scope, so it can be reused. A control node owns no run of its own, so its success is its
  // descendants'. A descendant that never ran (an untaken branch arm, a zero-iteration `while-do` body)
  // is skipped, not broken: K does not depend on it, so it does not gate the prefix — only a ran-but-
  // unsucceeded descendant does. The engine's `resolve-legal-k.ts` #5 owns this rule; this mirrors it.
  for (const prefixNode of rootFile.body.slice(0, topLevelIndex)) {
    for (const inner of walkNodes([prefixNode])) {
      if (!RUN_PRODUCING_TYPES.has(inner.type)) continue;
      if (scopeRunState(runs.values(), rootRunId, inner.id) === "unsucceeded") {
        return {
          ok: false,
          reason: "prefix-unsucceeded",
          message: `A node before “${nodeName}” did not succeed; the whole prefix must succeed to reuse it.`,
        };
      }
    }
  }

  return null;
}
