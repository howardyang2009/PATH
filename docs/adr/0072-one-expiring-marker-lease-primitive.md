# One expiring-marker lease primitive, two policies over it

**Status:** accepted. Holds the pattern of [ADR 0017](0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md)
and [ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md) to one
implementation.

Two independent implementations of the same protocol had grown up:

| | Designer edit lease (`server/edit-lease.ts`) | Complete lease (`engine/persistence/complete-lease.ts`) |
| --- | --- | --- |
| TTL | 30 s | 10 min |
| holder | the client's `session_id` | a server-minted `randomUUID` |
| renew | heartbeat | none |
| takeover | explicit, operator-confirmed | none |
| refusal | held + the holder's expiry, as a `WireLockHeldBody` | `null` |
| unreadable marker | reclaimable, tracking whether the file existed | reclaimable |
| marker JSON | `{session_id, acquired_at, heartbeat_at, expires_at}` | `{holder, expires_at}` |
| codec | the wire lease's field names | the default minimal shape |

Both implemented read-marker → is-it-live → grant-or-refuse → exclusive `wx` create with an `EEXIST`
fallback → holder-scoped release. The divergences are all *policy*; the protocol underneath was
duplicated, so a fix to the reclaim rule, the race path or the release rule had to be made twice.
`edit-lease`'s `now: () => number` seam, meant to make expiry testable, was used by no caller and no
test; the Complete lease had no clock seam at all, and `workflow-lock.test.ts` authored expired
markers by hand to reach the case.

## Decision

1. **The protocol moves to `@path/engine`**: `persistence/marker-lease.ts` —
   `acquireMarkerLease`, `renewMarkerLease`, `releaseMarkerLease`, `readMarkerLease`,
   `removeMarkerLease`, and the `MarkerLeaseGrant` facade. It is a `.path/` file-state primitive like
   `openDb` / `pathDir`, so it sits in the lower tier both callers already depend on.
2. **The protocol's view of a marker is canonical — `{holder, acquiredAt, grantedAt, expiresAt}` —
   but its field names on disk are the caller's**, through a `MarkerCodec`. The Designer's marker
   keeps the wire lease's four fields, because an operator reads that file and a hand-authored marker
   must still be honored (ADR 0017); the Complete lease uses the default minimal shape. The protocol
   is what was duplicated, not the key names.
3. **A clock is injected**, so expiry and reclaim are facts of a fixture rather than a wait.
4. **Each caller keeps only its policy.** The server's `edit-lease.ts` keeps the marker's path beside
   its workflow (with root confinement), the 30 s TTL, the `WireWorkflowLease` / `WireLockHeldBody`
   mapping, the takeover affordance, and the heartbeat; the engine's `complete-lease.ts` keeps the
   10 min TTL, a fresh holder id per acquisition, and `null` on a held tree.
5. **The protocol is tested once, at the primitive**: liveness, own-holder re-grant, expiry and
   corrupt-marker reclaim, refusal, takeover, renew, holder-scoped release, and the `wx` race.

## Considered Options

- **One primitive in the engine** (chosen). The server already depends on the engine; the reverse
  would be a cycle, and a third package for one file-state protocol is not worth a workspace entry.
- **A shared interface with two adapters** — a `MarkerLease` port implemented by each caller.
  Rejected: the *implementations* were the duplication, not the call sites, so the port would have
  left both copies in place.
- **Leave them apart and align the constants.** Rejected. The race arbitration and the release rule
  are the parts that must not differ, and they were the parts already copied.
- **Put it in `@path/schema`.** Rejected: schema is browser-safe and free of `node:fs`.

## Consequences

- **No marker file changes shape.** The Designer's marker stays the wire lease it always was; the
  Complete lease's marker is unchanged. Only the code underneath is one implementation now.
- **A marker whose fields the codec cannot read is reclaimable**, as it always was; the codec is
  where a caller says which fields those are.
- **The Designers' heartbeat and takeover semantics are unchanged**: the same TTL, the same wire
  fields, the same refusal wording (including the distinct "just locked in another session" for a
  marker that raced in).
- **`edit-lease`'s clock seam is now real**, so the expiry path can be tested without hand-authoring
  a marker file; the HTTP test that does so still passes and still pins the door.
- **`CONTEXT.md` needs no change.** "Lease" is not a glossary term; the edit lease appears only as a
  property of a Buffer, which is unchanged.
