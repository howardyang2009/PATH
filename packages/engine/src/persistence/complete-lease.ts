import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireMarkerLease } from "./marker-lease.js";
import { rootRunTreeDir } from "./paths.js";

/**
 * The per-root-run **Complete lease** (ADR 0041, over the marker-lease primitive): single-writer
 * exclusion so only one Complete advances a tree at a time, and a concurrent one is rejected for the
 * person to retry.
 *
 * The marker file **is** the state, so a restart does not lose it, and reclaim is lazy — an expired
 * marker is evaluated only when the next Complete acquires that tree's lease.
 */

const LEASE_FILE = "complete.lease";

// Generous, because one lease is held for a whole tail drive that may run a real binary or LLM
// step. A tail outliving it is the rare case a racing Complete could reclaim; ADR 0041 promises no
// atomicity.
const TTL_MS = 10 * 60_000;

/** The live lease held by this call, if it won the tree. `release` is idempotent and
 * holder-scoped. */
export interface CompleteLease {
  release(): void;
}

/**
 * Acquires the Complete lease for `rootRunId`, or returns `null` when a **live** lease is already
 * held. Every call mints a fresh holder id, so the primitive's own-holder re-acquire never applies
 * here: any live marker belongs to someone else.
 */
export function acquireCompleteLease(projectDir: string, rootRunId: string): CompleteLease | null {
  const result = acquireMarkerLease({
    path: join(rootRunTreeDir(projectDir, rootRunId), LEASE_FILE),
    holder: randomUUID(),
    ttlMs: TTL_MS,
  });
  if (!result.ok) return null;
  const { grant } = result;
  return { release: () => grant.release() };
}
