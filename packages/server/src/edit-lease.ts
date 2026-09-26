import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WireLockHeldBody, WireWorkflowLease } from "@path/schema";
import { confineToProjectRoot } from "./confine.js";

/**
 * The Designer **edit lease** (ADR 0017, issue #364): a server-owned, expiring, file-based marker
 * `<name>.workflow.json.editing` beside the workflow it guards. It is Designer-to-Designer mutual
 * exclusion, so a second tab is warned before its first keystroke; it complements, never replaces, the
 * write door's `If-Match` precondition (ADR 0016), which alone protects the bytes against every writer.
 *
 * The marker file **is** the state: no in-memory registry, so a restart neither loses nor rebuilds a
 * lease, and reclaim is lazy — an expired marker is judged only when someone next touches that file.
 *
 * Every operation is synchronous (no `await`), so a read-decide-write never interleaves with another
 * request of this process — the write door's concurrency stance.
 */

/** TTL 30s (ADR 0017): a live tab heartbeats every 10s; a crashed one frees the marker within 30s. */
const TTL_MS = 30_000;

/** The marker's suffix. Discovery is blind to it (it fails `endsWith(".workflow.json")`) and `.gitignore` ignores it. */
const MARKER_SUFFIX = ".editing";

/** The marker's JSON — `@path/schema`'s wire shape, the same interface the Designer reads it back through. */
export type Lease = WireWorkflowLease;

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; held: WireLockHeldBody };

/** The edit lease of one workflow file. */
export interface EditLease {
  /**
   * Grant the lease to `sessionId` when no marker exists, it expired, the caller already holds it, or
   * `takeover` is set. A live lease held by another session is refused with its expiry, so the UI can
   * offer a timed takeover.
   */
  acquire(sessionId: string, takeover: boolean): AcquireResult;
  /** Extend the caller's own lease; `undefined` when it no longer holds it (reclaimed or taken over). */
  renew(sessionId: string): Lease | undefined;
  /** Free the caller's own lease; `false` when it did not hold one. Never frees another session's. */
  release(sessionId: string): boolean;
  /** Is a live lease held by a session other than `sessionId`? */
  heldByOther(sessionId: string | null): boolean;
  /** Remove the marker whoever holds it — the file it guards is being deleted. */
  remove(): void;
}

/**
 * The edit lease of `workflowPath`, or `undefined` when its marker would escape the project root or
 * traverse a symlink — the write door's confinement (ADR 0017 decision 7). The marker itself may not
 * exist yet.
 */
export function editLease(
  projectDir: string,
  workflowPath: string,
  now: () => number = Date.now,
): EditLease | undefined {
  const markerPath = confineToProjectRoot(resolve(projectDir), `${workflowPath}${MARKER_SUFFIX}`, {
    allowMissingTail: true,
  });
  if (markerPath === undefined) return undefined;

  const isLive = (lease: Lease | undefined): lease is Lease =>
    lease !== undefined && now() <= Date.parse(lease.expires_at);
  const window = (at: number) => ({
    heartbeat_at: new Date(at).toISOString(),
    expires_at: new Date(at + TTL_MS).toISOString(),
  });

  return {
    acquire(sessionId, takeover) {
      const { fileExists, lease } = readLease(markerPath);
      const live = isLive(lease);
      if (live && lease.session_id !== sessionId && !takeover) {
        return {
          ok: false,
          held: {
            error: { message: "workflow is being edited in another session" },
            held_by_other: true,
            expires_at: lease.expires_at,
          },
        };
      }
      // Re-acquiring one's own live lease keeps its `acquired_at`; every other grant starts a new window.
      const at = now();
      const granted: Lease = {
        session_id: sessionId,
        acquired_at:
          live && lease.session_id === sessionId ? lease.acquired_at : new Date(at).toISOString(),
        ...window(at),
      };
      // A fresh grant uses `wx`, so a marker another OS process created since the read fails rather
      // than being clobbered; a reclaim or takeover overwrites.
      mkdirSync(dirname(markerPath), { recursive: true });
      try {
        writeFileSync(markerPath, serializeLease(granted), fileExists ? undefined : { flag: "wx" });
      } catch (err) {
        if (fileExists || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Undefined only when the racing marker is unreadable; JSON then omits the field.
        const raced = readLease(markerPath).lease;
        return {
          ok: false,
          held: {
            error: { message: "workflow was just locked in another session" },
            held_by_other: true,
            expires_at: raced?.expires_at as string,
          },
        };
      }
      return { ok: true, lease: granted };
    },

    renew(sessionId) {
      const { lease } = readLease(markerPath);
      if (lease === undefined || lease.session_id !== sessionId) return undefined;
      const renewed: Lease = { ...lease, ...window(now()) };
      writeFileSync(markerPath, serializeLease(renewed));
      return renewed;
    },

    release(sessionId) {
      const { lease } = readLease(markerPath);
      if (lease === undefined || lease.session_id !== sessionId) return false;
      rmSync(markerPath, { force: true });
      return true;
    },

    heldByOther(sessionId) {
      const { lease } = readLease(markerPath);
      return isLive(lease) && lease.session_id !== sessionId;
    },

    remove() {
      rmSync(markerPath, { force: true });
    },
  };
}

/**
 * Read a marker. `fileExists` tells a bare "no marker" (a grant may `wx`-create) from a present but
 * unparseable one, which is treated as expired and reclaimable.
 */
function readLease(absPath: string): { fileExists: boolean; lease?: Lease } {
  let bytes: string;
  try {
    bytes = readFileSync(absPath, "utf8");
  } catch {
    return { fileExists: false };
  }
  try {
    const parsed = JSON.parse(bytes) as Partial<Lease>;
    if (typeof parsed.session_id === "string" && typeof parsed.expires_at === "string") {
      return { fileExists: true, lease: parsed as Lease };
    }
  } catch {
    // A hand-mangled or truncated marker is not a valid lease.
  }
  return { fileExists: true };
}

/** Deterministic serialization, matching the write door: 2-space indent, trailing newline. */
function serializeLease(lease: Lease): string {
  return `${JSON.stringify(lease, null, 2)}\n`;
}
