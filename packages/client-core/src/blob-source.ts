import { type BlobName, isRootRun } from "@path/schema";
import type { RunNodeState } from "./view-model.js";

/**
 *
 * A run's blob, addressed the way a surface must read it — **one owner** for "which run holds this object, and where
 * does it live on disk". Restates `@path/engine`'s `persistence/paths.ts` layout for a reader that renders it beside
 * the object.
 *
 */

/** One blob as a surface reads it: the addressing, the read's gate, and the provenance line. */
export interface RunBlobSource {
  /** The tree the object is read under — a successor root's input is read under its **predecessor's** tree. */
  rootRunId: string;
  runId: string;
  /** The record's ref gating the read, or `null` to read unconditionally and trust a 404 (`blob-absence.ts`'s rule). */
  gatedBy: string | null;
  /** The on-disk provenance line shown beside the object, or `null` when the run recorded none. */
  ref: string | null;
  /** The predecessor root a **successor root's input** comes from. */
  resumedFrom: string | null;
}

/** The stable address when the record carries no ref: the sibling ref's filename swapped, else the canonical
 * `runs/<root>/<run>/context.json` (§6, ADR 0006).
 */
function contextRef(run: RunNodeState): string {
  const sibling = run.inputRef ?? run.outputRef;
  return sibling !== null
    ? sibling.replace(/[^/]+$/, "context.json")
    : `runs/${run.rootRunId}/${run.runId}/context.json`;
}

/** Where one run's blob is read from. For `input` on a **successor root** the source is the predecessor's own
 * `input.json` — the successor writes an empty seed of its own, and the input its tree started from belongs to the
 * run it resumed (ADR 0032).
 */
export function runBlobSource(run: RunNodeState, name: BlobName): RunBlobSource {
  if (name === "context") {
    return {
      rootRunId: run.rootRunId,
      runId: run.runId,
      gatedBy: null,
      ref: contextRef(run),
      resumedFrom: null,
    };
  }

  if (name === "input") {
    const predecessor = isRootRun(run) ? run.resumedFromRootRunId : null;
    if (typeof predecessor === "string") {
      return {
        rootRunId: predecessor,
        runId: predecessor,
        // The predecessor is terminal, so its 404 means "that tree recorded no input" rather than an
        // error — never gated on this successor row's own (empty) input ref.
        gatedBy: null,
        ref: `runs/${predecessor}/${predecessor}/input.json`,
        resumedFrom: predecessor,
      };
    }
    return {
      rootRunId: run.rootRunId,
      runId: run.runId,
      gatedBy: run.inputRef,
      ref: run.inputRef,
      resumedFrom: null,
    };
  }

  return {
    rootRunId: run.rootRunId,
    runId: run.runId,
    gatedBy: run.outputRef,
    ref: run.outputRef,
    resumedFrom: null,
  };
}
