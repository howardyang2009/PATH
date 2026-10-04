import {
  type ControlBlockKind,
  type LegalKBoundaryReason,
  type LegalKBoundaryRefusal,
  legalKBoundary,
  type RunRecord,
  type WorkflowFile,
} from "@path/schema";
import { shortGuid } from "./node-label.js";

/** The Designer's half of the one legal-K verdict (`@path/schema`'s `legalKBoundary`, whose engine
 * door is `resume-legal-k.ts`): the button computes eligibility eagerly from the run tree + open
 * root file, so an illegal pick greys before a round-trip. It reads only the root level's body — a
 * nested K sits in a file the Designer does not hold — so the shared verdict judges the levels past
 * its reach on their own run status alone, and the engine's `refusal` on click stays the last word.
 */
export type ResumeFromReasonCode =
  | "no-selection" // spec rule 1 — nothing selected, or the root row (never a K)
  | LegalKBoundaryReason // every reason the shared verdict can give
  | "dirty-buffer"; // spec rule 3 — a legal K, but the open file is not saved

/** The innermost enclosing controller named in an `in-body` reason (`loop` is `while-do`), as the
 * engine. */
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

/** The short run id shown in the button label; the full id is the wire value and the hover
 * title. */
export function shortRunId(runId: string): string {
  return shortGuid(runId);
}

/** Compute the button's one state: enabled, or disabled with the highest-precedence reason —
 * no selection, then an illegal K, then a legal K over a dirty buffer. */
export function resumeFromEligibility(args: ResumeFromEligibilityArgs): ResumeFromEligibility {
  const { runs, rootFile, selectedRunId, dirty } = args;

  // (1) Nothing selected — the button's rest state. The root row folds in here: it owns no node, so
  // it is never a K.
  if (selectedRunId === null) return noSelection();

  // (2) The shared verdict, scoped to the one level this surface can see.
  const verdict = legalKBoundary(
    runs.values(),
    selectedRunId,
    rootFile === null ? { bodies: [] } : { bodies: [rootFile.body] },
  );
  if (!verdict.ok) {
    const { reason } = verdict.refusal;
    // The tree's own facts are the button's rest state, not a reason to show.
    if (reason === "not-in-tree" || reason === "root-run") return noSelection();
    return {
      ok: false,
      reason,
      message: shortMessage(verdict.refusal),
      ...(verdict.refusal.container ? { container: verdict.refusal.container } : {}),
    };
  }
  const { run, nodeName } = verdict;

  // (3) A legal K over an unsaved file — Launch's save-first gate, last in precedence.
  if (dirty) {
    return { ok: false, reason: "dirty-buffer", message: "Save to enable." };
  }

  return { ok: true, runId: run.runId, nodeName, shortRunId: shortRunId(run.runId) };
}

function noSelection(): ResumeFromEligibility {
  return { ok: false, reason: "no-selection", message: "Select a node in the run tree." };
}

/** The button's own copy of a refusal: the reason is the shared verdict's, the sentence is the
 * surface's (the engine prints its longer, CLI-shaped wording). */
function shortMessage(refusal: LegalKBoundaryRefusal): string {
  const { nodeName: label = refusal.runId } = refusal;
  switch (refusal.reason) {
    case "pass-run":
      return `Pass ${refusal.pass} is a goto pass, not a node; select a node inside it.`;
    case "not-in-file":
      return `“${label}” is no longer in the workflow.`;
    case "in-body":
      return `“${label}” is inside a ${refusal.container ?? "loop, parallel, or branch"} body and cannot be a rerun boundary.`;
    case "not-succeeded":
      return `“${label}” did not succeed.`;
    case "prefix-unsucceeded":
      return `A node before “${label}” did not succeed; the whole prefix must succeed to reuse it.`;
    // A nested `ref` cannot be judged from here, so these two are the engine's to refuse; the
    // switch still accounts for them.
    case "not-workflow":
      return `“${label}” is no longer a nested workflow.`;
    case "ref-unresolved":
      return `“${label}” references a file that is no longer in the workflow.`;
    case "not-in-tree":
    case "root-run":
      return "Select a node in the run tree.";
  }
}
