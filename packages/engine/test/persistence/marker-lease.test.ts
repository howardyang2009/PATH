import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireMarkerLease,
  type MarkerCodec,
  readMarkerLease,
  releaseMarkerLease,
  removeMarkerLease,
  renewMarkerLease,
} from "../../src/persistence/marker-lease.js";

/**
 * The expiring-marker lease primitive (ADR 0017 / ADR 0041) through its own interface: one file,
 * one holder at a time, lazy reclaim of an expired or unreadable marker, and a holder-scoped
 * release. The clock is injected, so expiry is a fact of the fixture rather than a wait.
 */

const TTL = 30_000;

let dir: string;
let marker: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marker-lease-"));
  marker = join(dir, "nested", "a.json.editing");
  clock = Date.parse("2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function acquire(holder: string, takeover = false) {
  return acquireMarkerLease({ path: marker, holder, ttlMs: TTL, takeover, now });
}

describe("acquireMarkerLease", () => {
  it("grants a fresh marker, creating its directory, and stamps a window", () => {
    const result = acquire("alice");

    expect(result.ok).toBe(true);
    expect(result.ok && result.grant.holder).toBe("alice");
    expect(result.ok && result.grant.expiresAt).toBe(new Date(clock + TTL).toISOString());
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      holder: "alice",
      acquired_at: new Date(clock).toISOString(),
    });
  });

  it("refuses a live marker held by someone else, reporting the holder and its expiry", () => {
    acquire("alice");
    clock += 1000;

    expect(acquire("bob")).toEqual({
      ok: false,
      holder: "alice",
      expiresAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + TTL).toISOString(),
    });
  });

  it("re-grants the caller's own live marker, keeping its original acquired_at", () => {
    const first = acquire("alice");
    clock += 1000;
    const second = acquire("alice");

    expect(second.ok && second.grant.acquiredAt).toBe(first.ok && first.grant.acquiredAt);
    expect(second.ok && second.grant.expiresAt).toBe(new Date(clock + TTL).toISOString());
  });

  it("reclaims an expired marker, and one that cannot be read at all", () => {
    acquire("alice");
    clock += TTL + 1;
    expect(acquire("bob").ok).toBe(true);

    writeFileSync(marker, "{ not json");
    expect(acquire("carol").ok).toBe(true);
    expect(readMarkerLease(marker, now)?.holder).toBe("carol");
  });

  it("takes over a live marker only when the caller asks", () => {
    acquire("alice");
    expect(acquire("bob").ok).toBe(false);
    expect(acquire("bob", true).ok).toBe(true);
    expect(readMarkerLease(marker, now)?.holder).toBe("bob");
  });

  it("never clobbers a marker that raced in between the read and the create", () => {
    // The marker appears after the read decided the file was absent: the exclusive `wx` create
    // fails, and the racer's own fields come back. The directory exists (the racer created it), and
    // the clock's first read is the liveness check — after the read, before the create.
    const raced = {
      holder: "racer",
      acquired_at: new Date(clock).toISOString(),
      expires_at: new Date(clock + TTL).toISOString(),
    };
    mkdirSync(join(dir, "nested"), { recursive: true });

    const result = acquireMarkerLease({
      path: marker,
      holder: "alice",
      ttlMs: TTL,
      now: () => {
        writeFileSync(marker, JSON.stringify(raced));
        return clock;
      },
    });

    expect(result).toEqual({ ok: false, holder: "racer", expiresAt: raced.expires_at });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(raced);
  });
});

describe("renewMarkerLease", () => {
  it("extends its own window and leaves another holder's alone", () => {
    acquire("alice");
    clock += 1000;
    const renewed = renewMarkerLease(marker, "alice", TTL, now);

    expect(renewed?.expiresAt).toBe(new Date(clock + TTL).toISOString());
    expect(renewMarkerLease(marker, "bob", TTL, now)).toBeUndefined();
    expect(renewMarkerLease(join(dir, "gone"), "alice", TTL, now)).toBeUndefined();
  });
});

describe("releaseMarkerLease", () => {
  it("frees only the caller's own marker, and is idempotent", () => {
    acquire("alice");

    expect(releaseMarkerLease(marker, "bob")).toBe(false);
    expect(readMarkerLease(marker, now)?.holder).toBe("alice");
    expect(releaseMarkerLease(marker, "alice")).toBe(true);
    expect(releaseMarkerLease(marker, "alice")).toBe(false);
    expect(readMarkerLease(marker, now)).toBeUndefined();
  });
});

describe("removeMarkerLease", () => {
  it("removes a marker whoever holds it", () => {
    acquire("alice");
    removeMarkerLease(marker);
    expect(readMarkerLease(marker, now)).toBeUndefined();
  });
});

describe("the marker's field names are the caller's (MarkerCodec)", () => {
  /** A caller that keeps the wire lease on disk — the Designer edit lease's shape (ADR 0017). */
  const wire: MarkerCodec = {
    encode: (marker) =>
      `${JSON.stringify(
        {
          session_id: marker.holder,
          acquired_at: marker.acquiredAt,
          heartbeat_at: marker.grantedAt,
          expires_at: marker.expiresAt,
        },
        null,
        2,
      )}\n`,
    decode: (text) => {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed.session_id !== "string" || typeof parsed.expires_at !== "string")
        return undefined;
      return {
        holder: parsed.session_id,
        acquiredAt: String(parsed.acquired_at ?? ""),
        grantedAt: String(parsed.heartbeat_at ?? ""),
        expiresAt: parsed.expires_at,
      };
    },
  };

  it("writes the codec's own shape and reads it back", () => {
    const result = acquireMarkerLease({
      path: marker,
      holder: "alice",
      ttlMs: TTL,
      now,
      codec: wire,
    });

    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      session_id: "alice",
      heartbeat_at: new Date(clock).toISOString(),
    });
    expect(readMarkerLease(marker, now, wire)?.holder).toBe("alice");
    expect(result.ok && result.grant.grantedAt).toBe(new Date(clock).toISOString());
  });

  it("still refuses another holder, and replaces unreadable bytes", () => {
    acquireMarkerLease({ path: marker, holder: "alice", ttlMs: TTL, now, codec: wire });
    clock += 1;
    expect(
      acquireMarkerLease({ path: marker, holder: "bob", ttlMs: TTL, now, codec: wire }),
    ).toMatchObject({ ok: false, holder: "alice" });

    writeFileSync(marker, '{"holder":"alice","expires_at":"2999-01-01T00:00:00.000Z"}');
    // The default codec cannot read that marker's missing `session_id`…
    expect(readMarkerLease(marker, now, wire)).toBeUndefined();
    // …so the next acquire replaces it.
    expect(
      acquireMarkerLease({ path: marker, holder: "bob", ttlMs: TTL, now, codec: wire }).ok,
    ).toBe(true);
  });
});
