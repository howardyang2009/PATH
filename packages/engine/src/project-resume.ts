import {
  childrenByParent,
  findRootRun,
  isTerminal,
  type JsonValue,
  type RunRecord,
  type RunStatus,
  type WorkflowFile,
} from "@path/schema";
import {
  continuationBlobReader,
  continuationRunOptions,
  sourceRuns,
  successorCapture,
} from "./continuation.js";
import { getLaunchFacts, getRunsForRoot } from "./persistence/run-store.js";
import type { ProjectCore, ProjectResumeOptions } from "./project.js";
import { type LegalKContainer, type LegalKReasonCode, resolveLegalK } from "./resume-legal-k.js";
import type { ContinuationInput } from "./run-options.js";

/**
 * The outcome of `Project.resume`: a Result because "no such root run" is ordinary operator input;
 * `found: true` carries the successor's own fresh root run id.
 */
export type ResumeResult =
  | { found: false; error: string }
  | { found: false; refusal: ResumeRefusal }
  | {
      found: true;
      rootRunId: string;
      // `awaiting` when the successor re-ran a person-activity step and parked; its root stays
      // `running`.
      status: "succeeded" | "failed" | "cancelled" | "awaiting";
      output: JsonValue;
      error?: string;
    };

/**
 * A Resume-from-K refusal: the legal-K authority rejected `rerunFromRunId` before any successor
 * started. `status` follows the §5 taxonomy (400 unsupported, 409 conflict).
 */
export interface ResumeRefusal {
  status: number;
  message: string;
}

/**
 * One node's `--list-eligible` verdict: `eligible: true` when it is a legal K, else the §5 taxonomy
 * classification of why — the same one `resolveLegalK` attaches to a `--from` refusal.
 */
export type EligibilityVerdict =
  | { eligible: true }
  | { eligible: false; reason: LegalKReasonCode; container?: LegalKContainer };

/** One row of the `--list-eligible` listing: a source-tree run and its eligibility verdict. */
export interface EligibilityRow {
  runId: string;
  /** The producing node's human `name`; null for the root run (the CLI renders `-`). */
  nodeName: string | null;
  status: RunStatus;
  verdict: EligibilityVerdict;
}

/**
 * The outcome of `Project.listEligible`: `found: false` carries the message a resume of this root
 * would; `found: true` carries every source-tree run in DFS pre-order.
 */
export type ListEligibleResult =
  | { found: false; error: string }
  | { found: true; rows: EligibilityRow[] };

/**
 * The precondition `resume` and `listEligible` share: the source tree named by `rootRunId` must
 * exist and be terminal. `getRunsForRoot` keys on `root_run_id`, so a child id returns no rows —
 * the same `not-found` case; terminality is read off the root row, a non-terminal source refused
 * whole.
 */
type ResumeSourceProblem =
  | { kind: "not-found"; message: string }
  | { kind: "non-terminal"; message: string };

function checkResumeSource(rows: RunRecord[], rootRunId: string): ResumeSourceProblem | undefined {
  const root = findRootRun(rows);
  if (rows.length === 0 || !root) {
    return { kind: "not-found", message: `no run found with root run id "${rootRunId}"` };
  }
  if (!isTerminal(root.status)) {
    return {
      kind: "non-terminal",
      message: `run "${rootRunId}" is still ${root.status}; resume needs a terminal source run`,
    };
  }
  return undefined;
}

/** The source tree's runs in depth-first pre-order: a node under its parent, children in stored
 * order. */
function preorderRuns(rows: RunRecord[]): RunRecord[] {
  const byParent = childrenByParent(rows);
  const root = findRootRun(rows);
  const out: RunRecord[] = [];
  const visit = (row: RunRecord): void => {
    out.push(row);
    for (const child of byParent.get(row.runId) ?? []) visit(child);
  };
  if (root) visit(root);
  return out;
}

/** `Project.resume`: re-run `rootFile` as a successor of the terminal tree rooted at
 * `rootRunId`. */
export async function resumeProjectRun(
  { db, absDir, execute }: ProjectCore,
  rootFile: WorkflowFile,
  rootRunId: string,
  workflowDir: string,
  opts: ProjectResumeOptions,
): Promise<ResumeResult> {
  // The raw predecessor tree, read once. `getRunsForRoot` keys on `root_run_id`, so an unknown or
  // child id yields no rows — the `found: false` case.
  const directRuns = getRunsForRoot(db, rootRunId);
  const problem = checkResumeSource(directRuns, rootRunId);
  if (problem !== undefined) {
    // Unknown root stays `error`; a non-terminal source is a 409 refusal. Both exit 1 on the CLI.
    return problem.kind === "not-found"
      ? { found: false, error: problem.message }
      : { found: false, refusal: { status: 409, message: problem.message } };
  }

  // Resume-from-K: resolve the source run id to the boundary node-id path and enforce legal-K here
  // — the one authority. The raw predecessor tree is the input, never the swapped one.
  const { rerunFromRunId, ...runOpts } = opts;
  let rerunFromNodePath: string[] | undefined;
  let rerunFromPasses: (number | null)[] | undefined;
  if (rerunFromRunId !== undefined) {
    // `files`/`workflowDir` let legal-K descend a nested K, one level per path element.
    const verdict = resolveLegalK(
      rootFile,
      directRuns,
      rerunFromRunId,
      runOpts.files ?? new Map(),
      workflowDir,
    );
    if (!verdict.ok) return { found: false, refusal: verdict.refusal };
    rerunFromNodePath = verdict.nodePath;
    rerunFromPasses = verdict.passes;
  }

  // The continuation recipe Resume and Complete share: rows with reuse rows swapped for their
  // source, a read-only blob reader, and the recorded launch facts.
  const originalRuns = sourceRuns(db, directRuns);
  const capture = successorCapture();
  const continuation: ContinuationInput = {
    kind: "resume",
    originalRuns,
    readBlob: continuationBlobReader(absDir),
    rerunFromNodePath,
    rerunFromPasses,
  };

  const result = await execute(
    rootFile,
    workflowDir,
    // Launch facts are identity-defining like `input` (ADR 0046): a resume recovers the
    // predecessor's frozen config and worker defaults; the file tier stays live.
    { ...continuationRunOptions(runOpts, getLaunchFacts(db, rootRunId)), continuation },
    [capture.observer],
  );

  return {
    found: true,
    rootRunId: capture.rootRunId(),
    status: result.status,
    output: result.output,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/** `Project.listEligible`: every source-tree run with its legal-K verdict, launching nothing. */
export function listEligibleRuns(
  { db }: ProjectCore,
  rootFile: WorkflowFile,
  rootRunId: string,
  workflowDir: string,
  files: Map<string, WorkflowFile>,
): ListEligibleResult {
  // The same raw rows `resume` feeds `resolveLegalK`, so the per-row verdict shares one authority.
  const directRuns = getRunsForRoot(db, rootRunId);
  const problem = checkResumeSource(directRuns, rootRunId);
  if (problem !== undefined) return { found: false, error: problem.message };

  // DFS pre-order, one row per run; each verdict is the shared legal-K predicate over that run id.
  const rows = preorderRuns(directRuns).map((run): EligibilityRow => {
    const verdict = resolveLegalK(rootFile, directRuns, run.runId, files, workflowDir);
    return {
      runId: run.runId,
      nodeName: run.nodeName,
      status: run.status,
      verdict: verdict.ok
        ? { eligible: true }
        : verdict.refusal.container !== undefined
          ? {
              eligible: false,
              reason: verdict.refusal.reason,
              container: verdict.refusal.container,
            }
          : { eligible: false, reason: verdict.refusal.reason },
    };
  });
  return { found: true, rows };
}
