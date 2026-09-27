import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One expiring marker file used as a lease (ADR 0017's edit lease, ADR 0041's Complete lease): the
 * file **is** the state, so a restart loses nothing and reclaim is lazy — an expired or unreadable
 * marker is judged only when the next holder asks for it. Every operation is synchronous, and a
 * cross-process race is settled by the exclusive `wx` create, so two holders can never both win.
 *
 * The protocol is this module's; the marker's **field names** are the caller's, through
 * {@link MarkerCodec}, because a lease file is read by the caller's peers (and by hand). The default
 * shape is `{ holder, acquired_at, expires_at }`.
 */

/** One marker as the lease protocol sees it, whatever the caller's field names are. */
export interface MarkerLeaseMarker {
  holder: string;
  acquiredAt: string;
  /** The instant this window was stamped — a heartbeat, for a caller that records one. */
  grantedAt: string;
  expiresAt: string;
}

/** How one caller's marker sits on disk. `decode` returns `undefined` for bytes that are not a
 * marker, which the protocol treats as expired and reclaimable. */
export interface MarkerCodec {
  encode(marker: MarkerLeaseMarker): string;
  decode(text: string): MarkerLeaseMarker | undefined;
}

/** The default shape: one key per field the protocol needs, no more. */
export const DEFAULT_MARKER_CODEC: MarkerCodec = {
  encode: (marker) =>
    `${JSON.stringify(
      {
        holder: marker.holder,
        acquired_at: marker.acquiredAt,
        expires_at: marker.expiresAt,
      },
      null,
      2,
    )}\n`,
  decode: (text) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return undefined;
    }
    const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof parsed.holder !== "string" || typeof parsed.expires_at !== "string")
      return undefined;
    const acquiredAt = typeof parsed.acquired_at === "string" ? parsed.acquired_at : "";
    return {
      holder: parsed.holder,
      acquiredAt,
      grantedAt: typeof parsed.heartbeat_at === "string" ? parsed.heartbeat_at : acquiredAt,
      expiresAt: parsed.expires_at,
    };
  },
};

/** The holder's own grant: what the marker says, and the two things a holder does with it. */
export interface MarkerLeaseGrant {
  readonly holder: string;
  readonly acquiredAt: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  /** Start a fresh window for this same holder, or `undefined` when the marker has moved on
   * (expired and reclaimed, or taken over). */
  renew(): MarkerLeaseGrant | undefined;
  /** Remove the marker while this holder still owns it; idempotent, and never frees another
   * holder's. */
  release(): boolean;
}

export interface MarkerLeaseRequest {
  /** The marker file's absolute path; its directory is created on a grant. */
  path: string;
  /** Who is asking. A live marker held by someone else is a refusal unless `takeover`. */
  holder: string;
  ttlMs: number;
  /** Grant over a live marker held by another holder — the operator-confirmed takeover. */
  takeover?: boolean;
  /** The clock; injectable so expiry is testable without waiting. */
  now?: () => number;
  /** The marker's on-disk shape; the default is the protocol's own. */
  codec?: MarkerCodec;
}

/** A refusal, with whatever the marker knew: `holder`/`expiresAt` are `null` only when the racing
 * marker could not be read at all. */
export type MarkerLeaseResult =
  | { ok: true; grant: MarkerLeaseGrant }
  | { ok: false; holder: string | null; expiresAt: string | null };

/** Read a marker; `exists` tells a bare "no marker" from a present but unreadable one, which is
 * treated as expired and reclaimable. */
function readMarker(
  absPath: string,
  codec: MarkerCodec,
): { exists: boolean; marker?: MarkerLeaseMarker } {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return { exists: false };
  }
  return { exists: true, marker: codec.decode(text) };
}

/** The live holder of a marker, or `undefined` when it is absent, expired or unreadable. */
export function readMarkerLease(
  absPath: string,
  now: () => number = Date.now,
  codec: MarkerCodec = DEFAULT_MARKER_CODEC,
): { holder: string; expiresAt: string } | undefined {
  const { marker } = readMarker(absPath, codec);
  if (marker === undefined || now() > Date.parse(marker.expiresAt)) return undefined;
  return { holder: marker.holder, expiresAt: marker.expiresAt };
}

/** Remove a marker whoever holds it — the file it guards is being deleted. */
export function removeMarkerLease(absPath: string): void {
  rmSync(absPath, { force: true });
}

/** Extend `holder`'s own window; `undefined` when the marker is gone or belongs to someone else. An
 * expired marker this holder authored is still its own and is revived. */
export function renewMarkerLease(
  absPath: string,
  holder: string,
  ttlMs: number,
  now: () => number = Date.now,
  codec: MarkerCodec = DEFAULT_MARKER_CODEC,
): MarkerLeaseGrant | undefined {
  const { marker } = readMarker(absPath, codec);
  if (marker?.holder !== holder) return undefined;
  const at = now();
  const renewed: MarkerLeaseMarker = {
    ...marker,
    grantedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + ttlMs).toISOString(),
  };
  writeFileSync(absPath, codec.encode(renewed));
  return grantOf(absPath, holder, renewed, { ttlMs, now, codec });
}

/** Free `holder`'s own marker; `false` when it did not hold one. Never frees another holder's. */
export function releaseMarkerLease(
  absPath: string,
  holder: string,
  codec: MarkerCodec = DEFAULT_MARKER_CODEC,
): boolean {
  const { marker } = readMarker(absPath, codec);
  if (marker?.holder !== holder) return false;
  rmSync(absPath, { force: true });
  return true;
}

function grantOf(
  absPath: string,
  holder: string,
  marker: MarkerLeaseMarker,
  window: { ttlMs: number; now: () => number; codec: MarkerCodec },
): MarkerLeaseGrant {
  return {
    holder,
    acquiredAt: marker.acquiredAt,
    grantedAt: marker.grantedAt,
    expiresAt: marker.expiresAt,
    renew: () => renewMarkerLease(absPath, holder, window.ttlMs, window.now, window.codec),
    release: () => releaseMarkerLease(absPath, holder, window.codec),
  };
}

/**
 * Ask for a marker's lease. A grant happens when nothing is there, the marker is expired or
 * unreadable, the caller is already the live holder (keeping its `acquired_at`), or `takeover` is
 * set; otherwise the live holder is reported back.
 */
export function acquireMarkerLease(request: MarkerLeaseRequest): MarkerLeaseResult {
  const { path: absPath, holder, ttlMs, takeover = false } = request;
  const now = request.now ?? Date.now;
  const codec = request.codec ?? DEFAULT_MARKER_CODEC;
  const { exists, marker } = readMarker(absPath, codec);
  const live = marker !== undefined && now() <= Date.parse(marker.expiresAt);
  if (live && marker.holder !== holder && !takeover) {
    return { ok: false, holder: marker.holder, expiresAt: marker.expiresAt };
  }

  const at = now();
  const granted: MarkerLeaseMarker = {
    holder,
    acquiredAt: live && marker.holder === holder ? marker.acquiredAt : new Date(at).toISOString(),
    grantedAt: new Date(at).toISOString(),
    expiresAt: new Date(at + ttlMs).toISOString(),
  };

  mkdirSync(dirname(absPath), { recursive: true });
  try {
    // A fresh grant uses `wx`, so a marker another OS process created since the read fails rather
    // than being clobbered; a reclaim or a takeover overwrites.
    writeFileSync(absPath, codec.encode(granted), exists ? undefined : { flag: "wx" });
  } catch (err) {
    if (exists || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const raced = readMarker(absPath, codec).marker;
    return { ok: false, holder: raced?.holder ?? null, expiresAt: raced?.expiresAt ?? null };
  }
  return { ok: true, grant: grantOf(absPath, holder, granted, { ttlMs, now, codec }) };
}
