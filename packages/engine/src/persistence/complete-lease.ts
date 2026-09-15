import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootRunTreeDir } from "./paths.js";

/**
 * The per-root-run **Complete lease** (ADR 0041, the ADR 0017 lease pattern): single-writer mutual
 * exclusion so only one Complete advances a given tree at a time. A concurrent Complete against a
 * held lease is rejected (the route maps it to `409`); the person retries rather than queueing, so a
 * Complete never re-introduces the held wait ADR 0039 removed.
 *
 * The marker file **is** the state — no in-memory registry — so a server restart neither loses nor
 * rebuilds it, and reclaim is lazy: an expired marker is evaluated only when the next Complete tries
 * to acquire *that* tree's lease. It lives inside the tree's own `.path/runs/<root>/` directory, which
 * is already covered by `.path/`'s self-gitignore, so it is never committed.
 *
 * Unlike the Designer edit lease there is no session identity or takeover: a Complete is a one-shot
 * server-driven action, not a live client holding a marker across keystrokes. The holder token exists
 * only so `release` frees the lease this call took and never one a racing Complete reclaimed after
 * expiry.
 */

/** The marker filename inside `.path/runs/<root>/`. */
const LEASE_FILE = "complete.lease";

/**
 * TTL: generous, because one lease is held for a whole tail drive, which may run a real binary or LLM
 * step. A crash frees the marker in ≤ this window; a tail that outlives it is the rare case a racing
 * Complete could reclaim — acceptable, since the ADR promises no crash-atomicity for the tail either.
 */
const TTL_MS = 10 * 60_000;

interface LeaseMarker {
  holder: string;
  expires_at: string;
}

/** The live lease held by this call, if it won the tree. `release` is idempotent and holder-scoped. */
export interface CompleteLease {
  release(): void;
}

function readMarker(absPath: string): LeaseMarker | undefined {
  let bytes: string;
  try {
    bytes = readFileSync(absPath, "utf8");
  } catch {
    return undefined; // no marker on disk
  }
  try {
    const parsed = JSON.parse(bytes) as Partial<LeaseMarker>;
    if (typeof parsed.holder === "string" && typeof parsed.expires_at === "string") {
      return parsed as LeaseMarker;
    }
  } catch {
    // A corrupt marker is treated as reclaimable (undefined), same as the Designer lease.
  }
  return undefined;
}

/**
 * Acquire the Complete lease for `rootRunId`, or `null` when a **live** lease is already held by
 * another Complete. Grants when no marker exists, the marker is expired, or the marker is corrupt.
 *
 * The read-decide-write is synchronous (no `await`), so no other request of this process interleaves —
 * the same concurrency stance the Designer write door and lock route take. A cross-*process* race
 * (two `path`/server processes over one store) is caught by the exclusive `wx` create when no marker
 * exists; the loser reads the winner's live marker and is rejected.
 */
export function acquireCompleteLease(projectDir: string, rootRunId: string): CompleteLease | null {
  const absPath = join(rootRunTreeDir(projectDir, rootRunId), LEASE_FILE);
  const now = Date.now();
  const existing = readMarker(absPath);
  const live = existing !== undefined && now <= Date.parse(existing.expires_at);
  if (live) return null;

  const holder = randomUUID();
  const marker: LeaseMarker = { holder, expires_at: new Date(now + TTL_MS).toISOString() };
  const serialized = `${JSON.stringify(marker, null, 2)}\n`;

  mkdirSync(rootRunTreeDir(projectDir, rootRunId), { recursive: true });
  try {
    // No marker on disk → exclusive create, so a marker that raced into existence between the read and
    // here is not clobbered. An expired/corrupt marker is present → overwrite it.
    writeFileSync(absPath, serialized, existing === undefined ? { flag: "wx" } : undefined);
  } catch (err) {
    if (existing === undefined && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return null; // another process created it first — treat as a held lease
    }
    throw err;
  }

  return {
    release(): void {
      // Free only the marker this call authored: a racing Complete that reclaimed an expired marker
      // holds a different token, and must not have its lease deleted out from under it.
      const current = readMarker(absPath);
      if (current?.holder === holder) rmSync(absPath, { force: true });
    },
  };
}
