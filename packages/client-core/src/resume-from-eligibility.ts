import {
  type BoundaryLevel,
  type ControlBlockKind,
  classifyLevelK,
  type LegalKLevelReason,
  type RunRecord,
  selectBoundary,
  type WorkflowFile,
} from "@path/schema";

/** Client half of the engine's one legal-K rule (`resume-legal-k.ts`): the button computes eligibility
 * eagerly from the run tree + open root file so an illegal pick greys it before a round-trip. A nested
 * K's since-deleted/in-body/prefix reasons are left to the engine's `refusal` on click.
 */
export type ResumeFromReasonCode =
  | "no-selection" // spec rule 1 — nothing selected, or the root row (never a K)
  | "pass-run" // a goto pass container row (ADR 0054 §3); K is a node inside it
  | LegalKLevelReason // engine rules 2–5, the per-level taxonomy shared with the engine (`classifyLevelK`)
  | "dirty-buffer"; // spec rule 3 — a legal K, but the open file is not saved

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

/** Compute the button's one state: enabled, or disabled with the highest-precedence reason —
 * no selection, then an illegal K, then a legal K over a dirty buffer. */
export function resumeFromEligibility(args: ResumeFromEligibilityArgs): ResumeFromEligibility {
  const { rootRunId, runs, rootFile, selectedRunId, dirty } = args;

  // (1) Nothing selected — the button's rest state. The root row folds in here: it owns no node, so it is never a K.
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

  // (2) An illegal K. A root-level K is located in the open file's body — the exact engine mirror. A
  // nested K sits in a file the Designer does not hold, so only its own success is checked here.
  const nodeName = selected.nodeName ?? selected.nodeId;
  const topLevel =
    levels.length === 1 && (levels[0]!.passRun ?? levels[0]!.run).parentRunId === rootRunId;
  if (topLevel && rootFile !== null) {
    const illegal = classifyTopLevel(rootFile, runs, levels[0]!, selected, nodeName);
    if (illegal) return illegal;
  } else if (selected.status !== "succeeded") {
    // A nested K whose own run did not succeed is illegal on any level (engine rule 4).
    return { ok: false, reason: "not-succeeded", message: `“${nodeName}” did not succeed.` };
  }

  // (3) A legal K over an unsaved file — Launch's save-first gate, last in precedence.
  if (dirty) {
    return { ok: false, reason: "dirty-buffer", message: "Save to enable." };
  }

  return { ok: true, runId: selected.runId, nodeName, shortRunId: shortRunId(selected.runId) };
}

function noSelection(): ResumeFromEligibility {
  return { ok: false, reason: "no-selection", message: "Select a node in the run tree." };
}

/** The shared `classifyLevelK` predicate (`@path/schema`) run over the open root file at the root
 * scope (K's pass run under a goto, earlier passes as prefix), returning the first illegal reason. */
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
