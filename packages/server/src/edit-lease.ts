import { resolve } from "node:path";
import {
  acquireMarkerLease,
  type MarkerCodec,
  type MarkerLeaseGrant,
  type MarkerLeaseMarker,
  readMarkerLease,
  releaseMarkerLease,
  removeMarkerLease,
  renewMarkerLease,
} from "@path/engine";
import type { WireLockHeldBody, WireWorkflowLease } from "@path/schema";
import { confineToProjectRoot } from "./confine.js";

/**
 * The Designer **edit lease** (ADR 0017), over the marker-lease primitive: an expiring marker
 * `<name>.workflow.json.editing` beside the workflow — Designer-to-Designer exclusion,
 * complementing the write door's `If-Match` precondition. This module owns what is the Designer's:
 * the marker's path beside its workflow, the TTL, the wire shape, and the takeover affordance. The
 * file-state protocol — is the marker live, the `wx` race, holder-scoped release — is the
 * primitive's.
 */

/** TTL 30s (ADR 0017): a live tab heartbeats every 10s; a crashed one frees the marker within
 * 30s. */
const TTL_MS = 30_000;

/** The marker's suffix; discovery is blind to it and `.gitignore` ignores it. */
const MARKER_SUFFIX = ".editing";

/** The marker's JSON — `@path/schema`'s wire shape, the same interface the Designer reads it back
 * through. */
export type Lease = WireWorkflowLease;

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; held: WireLockHeldBody };

export interface EditLease {
  /**
   * Grant the lease to `sessionId` unless a live lease is held by another session and `takeover` is
   * unset, in which case refuse with its expiry so the UI can offer a timed takeover.
   */
  acquire(sessionId: string, takeover: boolean): AcquireResult;
  /** Extend the caller's own lease; `undefined` when it no longer holds it (reclaimed or taken
   * over). */
  renew(sessionId: string): Lease | undefined;
  /** Free the caller's own lease; `false` when it did not hold one. Never frees another
   * session's. */
  release(sessionId: string): boolean;
  /** Is a live lease held by a session other than `sessionId`? */
  heldByOther(sessionId: string | null): boolean;
  /** Remove the marker whoever holds it — the file it guards is being deleted. */
  remove(): void;
}

/** The wire shape of one grant: the holder is the client's `session_id`, and every window instant
 * comes from the grant's own stamp. */
function toWire(
  sessionId: string,
  grant: Pick<MarkerLeaseGrant, "acquiredAt" | "grantedAt" | "expiresAt">,
): Lease {
  return {
    session_id: sessionId,
    acquired_at: grant.acquiredAt,
    heartbeat_at: grant.grantedAt,
    expires_at: grant.expiresAt,
  };
}

/**
 * The marker's JSON **is** the wire lease (ADR 0017): an operator who reads the file sees the same
 * four server-stamped fields the Designer got back, and a hand-authored marker is honored. That
 * shape is this door's policy; the lease protocol underneath is the primitive's.
 */
const EDIT_LEASE_CODEC: MarkerCodec = {
  encode: (marker: MarkerLeaseMarker) =>
    `${JSON.stringify(toWire(marker.holder, marker), null, 2)}\n`,
  decode: (text: string) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof parsed.session_id !== "string" || typeof parsed.expires_at !== "string")
      return undefined;
    const acquiredAt = typeof parsed.acquired_at === "string" ? parsed.acquired_at : "";
    return {
      holder: parsed.session_id,
      acquiredAt,
      grantedAt: typeof parsed.heartbeat_at === "string" ? parsed.heartbeat_at : acquiredAt,
      expiresAt: parsed.expires_at,
    };
  },
};

/**
 * The edit lease of `workflowPath`, or `undefined` when its marker would escape the project root or
 * traverse a symlink (ADR 0017 decision 7).
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

  /** The refusal the Designer reads: the live holder's expiry, so it can offer a takeover. */
  const held = (message: string, expiresAt: string | null): AcquireResult => ({
    ok: false,
    held: {
      error: { message },
      held_by_other: true,
      expires_at: expiresAt as string,
    },
  });

  return {
    acquire(sessionId, takeover) {
      const result = acquireMarkerLease({
        path: markerPath,
        holder: sessionId,
        ttlMs: TTL_MS,
        takeover,
        now,
        codec: EDIT_LEASE_CODEC,
      });
      if (result.ok) return { ok: true, lease: toWire(sessionId, result.grant) };
      // A marker that raced in between the read and the create could not be read back; say so
      // rather than reporting a holder the caller never saw.
      return held(
        result.holder === null
          ? "workflow was just locked in another session"
          : "workflow is being edited in another session",
        result.expiresAt,
      );
    },

    renew(sessionId) {
      const grant = renewMarkerLease(markerPath, sessionId, TTL_MS, now, EDIT_LEASE_CODEC);
      return grant === undefined ? undefined : toWire(sessionId, grant);
    },

    release(sessionId) {
      return releaseMarkerLease(markerPath, sessionId, EDIT_LEASE_CODEC);
    },

    heldByOther(sessionId) {
      const live = readMarkerLease(markerPath, now, EDIT_LEASE_CODEC);
      return live !== undefined && live.holder !== sessionId;
    },

    remove() {
      removeMarkerLease(markerPath);
    },
  };
}
