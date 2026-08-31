import { PathApiError } from "./api-client.js";
import type { JsonValue } from "@path/schema";

/**
 * A blob read that succeeded: either the run has that object, or the run record carries no ref for
 * it yet. `present` carries the difference a bare `JsonValue | null` cannot — an object whose
 * content *is* JSON `null` is a written object, not a missing one.
 */
export type BlobContent = { present: false } | { present: true; value: JsonValue };

/**
 * What a blob read should do before it starts, decided from the ref and the run's settled state
 * alone — the surface's `useState`/`useEffect` wiring reads this and never re-derives the rule.
 *
 * Who decides absence depends on whether the run is still going, because the two ways of deciding
 * fail in opposite directions:
 *
 * - **Still running, no ref** — skip the read. The route answers 404 for an unknown root, a run
 *   outside that root's tree *and* a missing file alike (`get-run-blob.ts`), so reading a 404 as
 *   "not written yet" would reassure a viewer whose selection is actually stale.
 * - **Terminal, or a ref in hand** — read. A terminal run came from the tree, so it is not a stale
 *   selection, and its ref may simply be absent from a snapshot no tree read has refreshed since the
 *   object was written (#51); its 404 is trusted afterward by {@link resolveBlobError}.
 */
export type BlobReadPlan = { read: false; content: BlobContent } | { read: true };

/** @see BlobReadPlan */
export function planBlobRead(ref: string | null, settled: boolean): BlobReadPlan {
  if (ref === null && !settled) {
    return { read: false, content: { present: false } };
  }
  return { read: true };
}

/**
 * Interpret an error thrown by the blob read. Returns the absence to record when the failure is the
 * one benign 404 — a terminal run whose record names no ref simply recorded no such object — and
 * `null` when the caller must surface the error instead (the record and the disk disagree: a ref
 * that *is* known and fails to load is an error either way).
 */
export function resolveBlobError(ref: string | null, error: unknown): BlobContent | null {
  if (ref === null && error instanceof PathApiError && error.status === 404) {
    return { present: false };
  }
  return null;
}
