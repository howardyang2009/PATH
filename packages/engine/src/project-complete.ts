import { findRootRun, isTerminal, type JsonValue, type WorkflowFile } from "@path/schema";
import { checkCompletedOutput } from "./complete-output.js";
import { continuationBlobReader, continuationRunOptions, sourceRuns } from "./continuation.js";
import { acquireCompleteLease } from "./persistence/complete-lease.js";
import {
  cancelNonTerminalRuns,
  getLaunchFacts,
  getRun,
  getRunsForRoot,
} from "./persistence/run-store.js";
import type { ProjectContinuationOptions, ProjectCore } from "./project.js";
import type { ContinuationInput } from "./run-options.js";

/**
 * The outcome of `Project.complete`: a Result because "no such leaf", "not awaiting" and "lease
 * held" are ordinary states the route maps to a status code.
 */
export type CompleteResult =
  | {
      ok: false;
      reason: "not-found" | "not-awaiting" | "lease-held" | "node-gone";
      message: string;
    }
  | { ok: false; reason: "output-invalid"; message: string; details?: unknown[] }
  | {
      ok: true;
      rootRunId: string;
      status: "succeeded" | "failed" | "cancelled" | "awaiting";
      output: JsonValue;
      error?: string;
    };

/** `Project.complete`: validate the output, take the per-root lease, then replay the tree to flip
 * the parked leaf. */
export async function completeProjectStep(
  { db, absDir, execute }: ProjectCore,
  rootFile: WorkflowFile,
  stepRunId: string,
  output: JsonValue,
  workflowDir: string,
  opts: ProjectContinuationOptions,
): Promise<CompleteResult> {
  // An unknown id is `not-found` (404); a leaf not `awaiting` — already succeeded, or a
  // double-submit — is `not-awaiting` (409).
  const leaf = getRun(db, stepRunId);
  if (leaf === undefined) {
    return {
      ok: false,
      reason: "not-found",
      message: `no step run found with id "${stepRunId}"`,
    };
  }
  if (leaf.status !== "awaiting") {
    return {
      ok: false,
      reason: "not-awaiting",
      message: `step run "${stepRunId}" is ${leaf.status}, not awaiting`,
    };
  }
  const rootRunId = leaf.rootRunId;
  // The appendable window closes when the tree reaches a terminal status: a leaf left `awaiting`
  // under a tree settled by another path is never re-driven.
  const rootRow = getRun(db, rootRunId);
  if (rootRow !== undefined && isTerminal(rootRow.status)) {
    return {
      ok: false,
      reason: "not-awaiting",
      message: `run "${rootRunId}" already finished with status "${rootRow.status}"`,
    };
  }

  // Validation before the lease: it is per-leaf, the lease per-tree, so a bad submit never contends
  // for the lease a valid sibling needs.
  const runOptions = continuationRunOptions(opts, getLaunchFacts(db, rootRunId));
  const check = checkCompletedOutput({
    rootFile,
    workflowDir,
    files: opts.files,
    operatorConfig: runOptions.operatorConfig,
    env: { ...process.env },
    stepRunId,
    nodeId: leaf.nodeId,
    output,
  });
  if (!check.ok) return check;

  // Per-root-run expiring lease: a held lease rejects (`lease-held` → 409) rather than queueing.
  const lease = acquireCompleteLease(absDir, rootRunId);
  if (lease === null) {
    return {
      ok: false,
      reason: "lease-held",
      message: `run "${rootRunId}" is being completed in another invocation`,
    };
  }
  try {
    // Re-read under the lease to close the TOCTOU against a Complete that flipped this leaf.
    const fresh = getRun(db, stepRunId);
    if (fresh === undefined || fresh.status !== "awaiting") {
      return {
        ok: false,
        reason: "not-awaiting",
        message: `step run "${stepRunId}" is ${fresh?.status ?? "gone"}, not awaiting`,
      };
    }

    // The continuation recipe `resume` uses: reuse rows swapped for their source record, so a
    // reused `succeeded` row addresses its own output blob.
    const directRuns = getRunsForRoot(db, rootRunId);
    const continuation: ContinuationInput = {
      kind: "complete",
      rootRunId,
      existingRuns: sourceRuns(db, directRuns),
      readBlob: continuationBlobReader(absDir),
      target: { stepRunId, output },
    };

    const result = await execute(
      rootFile,
      workflowDir,
      // A Complete replays the same tree, so it restores that tree's recorded launch facts: the
      // launch config (with any supplied secret merged over it) and its worker defaults.
      { ...runOptions, continuation },
      [],
    );
    return {
      ok: true,
      rootRunId,
      status: result.status,
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  } finally {
    lease.release();
  }
}

/** `Project.cancel`: cancel a parked `awaiting` tree at the store, under the Complete lease. */
export function cancelAwaitingRun({ db, absDir }: ProjectCore, rootRunId: string): boolean {
  const rows = getRunsForRoot(db, rootRunId);
  const root = findRootRun(rows);
  // Unknown or already-terminal trees are the route's to answer (404 / already-finished).
  if (!root || isTerminal(root.status)) return false;
  // Only a *parked* tree is safe to cancel here: an `awaiting` leaf means the engine tore down; a
  // non-terminal tree without one may be live elsewhere.
  if (!rows.some((r) => r.status === "awaiting")) return false;
  // Take the Complete lease so this never races a Complete advancing the same tree.
  const lease = acquireCompleteLease(absDir, rootRunId);
  if (lease === null) return false;
  try {
    cancelNonTerminalRuns(db, rootRunId);
    return true;
  } finally {
    lease.release();
  }
}
