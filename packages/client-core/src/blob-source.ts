import { isRootRun, type BlobName } from "@path/schema";
import type { RunNodeState } from "./view-model.js";

/**
 * A run's blob, addressed the way a surface must read it — **one owner** for "which run holds this
 * object, and where does it live on disk".
 *
 * **What this module exists to own.** The run record carries `input_ref`/`output_ref` and nothing for
 * `context` (there is no `context_ref` column), and a **successor root** reads its input from the tree
 * it resumed, not from its own row (direct-to-source, the same reading a reuse row gets). So a surface
 * that shows a run's input, output and context has to answer three layout questions: which run the
 * object belongs to, whether the record's ref gates the read, and what on-disk path the provenance line
 * should print. The Viewer answered them inline — swapping a filename on a sibling ref, hand-building
 * `runs/<root>/<run>/context.json`, and spelling the predecessor's path for a successor root.
 *
 * Here it is one function per object. Nothing below is server-side knowledge a browser could not have:
 * it is the layout `@path/engine`'s `persistence/paths.ts` owns, restated for a reader that must render
 * it beside the object it read.
 */

/** One blob as a surface reads it: the request's addressing, the read's gate, and the provenance line. */
export interface RunBlobSource {
  /** The tree the object is read under — a successor root's input is read under its **predecessor's** tree. */
  rootRunId: string;
  /** The run the object is read from. */
  runId: string;
  /**
   * The record's ref that signs this object's readiness, or `null` when the read must be unconditional.
   * A ref appearing in a live snapshot is one moment the object is known to be readable; a `null` gate
   * means "ask anyway and trust a 404" (`blob-absence.ts`'s rule).
   */
  gatedBy: string | null;
  /** The on-disk provenance line a surface shows beside the object, or `null` when the run recorded none. */
  ref: string | null;
  /** The predecessor root a **successor root's input** comes from; `null` for every other read. */
  resumedFrom: string | null;
}

/**
 * The stable address of a run's blob when the record carries no ref to derive it from. A context object
 * sits beside the run's other blobs, so the sibling ref's filename is swapped when there is one; a
 * workflow-run that recorded no input or output falls back to this shape (§6, ADR 0006).
 */
function contextRef(run: RunNodeState): string {
  const sibling = run.inputRef ?? run.outputRef;
  return sibling !== null ? sibling.replace(/[^/]+$/, "context.json") : `runs/${run.rootRunId}/${run.runId}/context.json`;
}

/**
 * Where one run's blob is read from, and how it reads. For `input` on a **successor root** the source is
 * the predecessor root's own `input.json`: the successor writes an empty seed of its own, and the input
 * its tree actually started from belongs to the run it resumed — the direct-to-source reading a reuse
 * row gets (#257), never a copy into the successor's tree.
 */
export function runBlobSource(run: RunNodeState, name: BlobName): RunBlobSource {
  if (name === "context") {
    // No `context_ref` rides on a run row, so there is no ref to gate the read or to signal a change:
    // read unconditionally and trust the 404 (a workflow-run has a context, a leaf step does not).
    return { rootRunId: run.rootRunId, runId: run.runId, gatedBy: null, ref: contextRef(run), resumedFrom: null };
  }

  if (name === "input") {
    const predecessor = isRootRun(run) ? run.resumedFromRootRunId : null;
    if (typeof predecessor === "string") {
      return {
        rootRunId: predecessor,
        runId: predecessor,
        // The predecessor is terminal, so its 404 is trusted as "that tree recorded no input" rather
        // than surfaced as an error — never gated on this successor row's own (empty) input ref.
        gatedBy: null,
        ref: `runs/${predecessor}/${predecessor}/input.json`,
        resumedFrom: predecessor,
      };
    }
    return { rootRunId: run.rootRunId, runId: run.runId, gatedBy: run.inputRef, ref: run.inputRef, resumedFrom: null };
  }

  return { rootRunId: run.rootRunId, runId: run.runId, gatedBy: run.outputRef, ref: run.outputRef, resumedFrom: null };
}
