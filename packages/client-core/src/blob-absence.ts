import type { JsonValue } from "@path/schema";
import { PathApiError } from "./api-client.js";

/** A blob read that succeeded; `present` carries the difference a bare `JsonValue | null` cannot — an object whose
 * content *is* JSON `null` is written, not missing.
 */
export type BlobContent = { present: false } | { present: true; value: JsonValue };

/** Whether to read at all — the one decider the surface's effects read instead of re-deriving the rule. A live
 * run with no ref skips the read: the route answers 404 for an unknown root, an out-of-tree run and a missing
 * file alike, so reading it as "not written yet" would trust a stale selection. A terminal run reads anyway and
 * trusts a 404.
 */
export type BlobReadPlan = { read: false; content: BlobContent } | { read: true };

/** @see BlobReadPlan */
export function planBlobRead(ref: string | null, settled: boolean): BlobReadPlan {
  if (ref === null && !settled) {
    return { read: false, content: { present: false } };
  }
  return { read: true };
}

/** The benign absence to record for the one benign `404` — a ref-less run that recorded no such object; `null` means
 * the caller must surface the error instead.
 */
export function resolveBlobError(ref: string | null, error: unknown): BlobContent | null {
  if (ref === null && error instanceof PathApiError && error.status === 404) {
    return { present: false };
  }
  return null;
}
