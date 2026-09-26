import {
  type BoundaryLevel,
  type ControlBlockKind,
  classifyLevelK,
  type LegalKLevelReason,
  type RunRecord,
  selectBoundary,
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
 * The taxonomy reasons are 1:1 with the engine's `LegalKReasonCode`, minus `not-in-tree` and
 * `root-run` (both fold into `no-selection`, spec #1) and plus the one surface-only state the button
 * layers on: `dirty-buffer` (spec #3).
 */
export type ResumeFromReasonCode =
  | "no-selection" // spec #1 — nothing selected, or the root row (never a K)
  | "pass-run" // a goto pass container row (ADR 0054 §3); K is a node inside it
  | LegalKLevelReason // engine #2–#5, the per-level taxonomy shared with the engine (`classifyLevelK`)
  | "dirty-buffer"; // spec #3 — a legal K, but the open file is not saved

/** The innermost enclosing controller named in an `in-body` reason (`loop` is `while-do`), as the engine. */
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
 * Compute the button's one state: enabled (`ok: true`, carrying the label parts) or disabled with the
 * single highest-precedence reason. Precedence (spec § Resume from here): (1) no node selected, then
 * (2) an illegal K in the engine's taxonomy order, then (3) a legal K over a dirty buffer.
 */
export function resumeFromEligibility(args: ResumeFromEligibilityArgs): ResumeFromEligibility {
  const { rootRunId, runs, rootFile, selectedRunId, dirty } = args;

  // (1) Nothing selected — the button's rest state. Selecting the root row folds in here: the root run
  // owns no node (an implicit root step), so it is never a K, and its only resume is plain Resume run.
  if (selectedRunId === null) return noSelection();
  const selection = selectBoundary(runs.values(), selectedRunId);
  if (selection.kind === "not-in-tree" || selection.kind === "root-run") return noSelection();
  if (selection.kind === "pass-run") {
    return {
      ok: false,
      reason: "pass-run",
      message: `Pass ${selection.pass} is a goto pass, not a node; select a node inside it.`,
    };
  }
  const { run: selected, levels } = selection;

  // (2) An illegal K. A root-level K (one descent level: a direct child of the root run, or of a goto
  // pass run of the root, ADR 0054) is located in the open file's body — the exact engine mirror. A
  // nested K sits in a file the Designer does not hold, so only its own success is checked here and the
  // engine backstops the rest.
  const nodeName = selected.nodeName ?? selected.nodeId;
  const topLevel =
    levels.length === 1 && (levels[0]!.passRun ?? levels[0]!.run).parentRunId === rootRunId;
  if (topLevel && rootFile !== null) {
    const illegal = classifyTopLevel(rootFile, runs, levels[0]!, selected, nodeName);
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
 * The root-level taxonomy check: the shared `classifyLevelK` predicate (`@path/schema`) run over the
 * open root file at the root scope (or, under a goto, at K's pass run with the earlier passes as prefix,
 * as the engine does), with the selected run as the leaf. Returns the first illegal reason
 * worded for the button, or `null` when the top-level K is legal. The rule body — locate (#2/#3), the
 * leaf's own success (#4), the prefix's success (#5) — is the one the engine authority runs; only the
 * message wording is the client's.
 */
function classifyTopLevel(
  rootFile: WorkflowFile,
  runs: ReadonlyMap<string, RunRecord>,
  { scopeRunId, earlierPassRunIds }: BoundaryLevel<RunRecord>,
  selected: RunRecord,
  nodeName: string,
): Extract<ResumeFromEligibility, { ok: false }> | null {
  const level = classifyLevelK({
    body: rootFile.body,
    rows: runs.values(),
    scopeRunId,
    nodeId: selected.nodeId!,
    leafStatus: selected.status,
    earlierPassRunIds,
  });
  if (level.ok) return null;
  switch (level.reason) {
    case "not-in-file":
      return {
        ok: false,
        reason: "not-in-file",
        message: `“${nodeName}” is no longer in the workflow.`,
      };
    case "in-body":
      return {
        ok: false,
        reason: "in-body",
        message: `“${nodeName}” is inside a ${level.container ?? "loop, parallel, or branch"} body and cannot be a rerun boundary.`,
        ...(level.container ? { container: level.container } : {}),
      };
    case "not-succeeded":
      return { ok: false, reason: "not-succeeded", message: `“${nodeName}” did not succeed.` };
    case "prefix-unsucceeded":
      return {
        ok: false,
        reason: "prefix-unsucceeded",
        message: `A node before “${nodeName}” did not succeed; the whole prefix must succeed to reuse it.`,
      };
  }
}
