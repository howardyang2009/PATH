import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootRunTreeDir } from "./paths.js";

/**
 * The per-root-run **Complete lease** (ADR 0041, the ADR 0017 lease pattern): single-writer exclusion so
 * only one Complete advances a tree at a time, and a concurrent one is rejected for the person to retry.
 *
 * The marker file **is** the state, so a restart does not lose it, and reclaim is lazy — an expired
 * marker is evaluated only when the next Complete acquires that tree's lease.
 */

const LEASE_FILE = "complete.lease";

// Generous, because one lease is held for a whole tail drive that may run a real binary or LLM step.
// A tail outliving it is the rare case a racing Complete could reclaim; ADR 0041 promises no atomicity.
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

// Acquires the Complete lease for `rootRunId`, or returns `null` when a **live** lease is already held.
// Grants when no marker exists, the marker is expired, or the marker is corrupt. The read-decide-write
// is synchronous, and a cross-*process* race is caught by the exclusive `wx` create.
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
    // No marker on disk → exclusive create, so a marker that raced in is not clobbered.
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
