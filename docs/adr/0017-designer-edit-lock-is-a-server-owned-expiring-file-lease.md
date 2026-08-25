# The Designer edit-lock is a server-owned expiring file lease, materialized on disk

**Status:** accepted; resolves [#258](https://github.com/howardyang2009/PATH/issues/258) on map
[#254](https://github.com/howardyang2009/PATH/issues/254) (the Designer spec). It complements
[ADR 0016](./0016-workflow-write-route-client-named-put-upsert-precondition-gated.md) (the `PUT` write
route and its ETag `If-Match` precondition,
[#257](https://github.com/howardyang2009/PATH/issues/257)). It reuses the resolve-and-confine seam of
`prepareWorkflow`/`resolveWorkflowPath` (`packages/server/src/launch.ts`, map decision 7) and the origin
gate `enforceSameOrigin` (`packages/server/src/origin-gate.ts`,
[#237](https://github.com/howardyang2009/PATH/issues/237), decision 8). It adds the first `@path/server`
state kept *beside a workflow file* rather than in the run store.

## Decision

**The edit-lock is a lease, not a bare marker, and the server owns it.** It is materialized as an
on-disk file `<name>.workflow.json.editing` that sits beside the workflow it guards (map decision 12).
It carries an expiry that the editing client keeps alive by heartbeat and that auto-expires after missed
beats (map decision 11). The alternative, a bare presence marker created on open and deleted on close,
has one dominant, unrecoverable failure: a browser cannot reliably delete a file on crash, sleep, or
force-quit, so the file locks forever. An expiring lease turns that permanent failure into a bounded one
(≤ one TTL), and an explicit takeover handles the case where a user is demonstrably the only editor.

**The lease is Designer-to-Designer mutual exclusion; it does not protect bytes.** Byte-level integrity
is entirely the ETag precondition's job (ADR 0016): every overwrite must present a matching `If-Match`
or take a `412`, and that precondition covers *every* writer (your editor, `git checkout`, `git stash
pop`, the CLI, a second Designer tab), none of which know the lease exists (map decision 10). The lease
exists so a second Designer tab is *warned or blocked before the first keystroke*, rather than a
discovery of the collision as a `412` at save time. Lease and precondition are orthogonal, and both are
required. Neither replaces the other.

**The marker file is the lease state; the server keeps no in-memory registry.** The `.editing` file is
the single source of truth: JSON, server-authored:

```json
{ "session_id": "<uuidv4>", "acquired_at": "<iso8601>", "heartbeat_at": "<iso8601>", "expires_at": "<iso8601>" }
```

`session_id` is minted **client-side** (a UUIDv4, echoing ADR 0015's client-mints-identity stance). It
is the only token a client presents to heartbeat, release, or take over. `expires_at` is computed by the
server (`heartbeat_at + TTL`) and never trusted from the client. There is no holder name or user field,
because the server has no auth (localhost, single origin, §2), so identity beyond the opaque
`session_id` would be fiction. Because the file *is* the state and expiry is a wall-clock timestamp, a
server restart is a non-event: no lease table to rebuild, no reaper to restart.

**Three POST routes, path in the body, under the `/v0/workflows` namespace.** They mirror the write
route's envelope (ADR 0016): the workflow's `/`-bearing relative path travels as an opaque
`workflow_path` body field, not a `%2F`-encoded URL segment, and it reuses the write route's
resolve/confine/symlink stance verbatim (decision 7):

- `POST /v0/workflows/lock` — acquire. Body `{ workflow_path, session_id, takeover? }`. It grants (`200`
  plus lease JSON) when no marker exists or the on-disk marker is expired (`now > expires_at`). A
  **live** marker held by a different `session_id` is a `409` whose body carries the current holder's
  `expires_at`, so the UI can say "someone is editing, expires in Ns" and offer takeover. `takeover:
  true` overwrites a live marker unconditionally (`200`), gated in the UI behind an explicit user
  confirmation. A fresh grant uses an exclusive create (`wx`); reclaim and takeover overwrite.
- `POST /v0/workflows/lock/heartbeat` — renew. Body `{ workflow_path, session_id }`. If the marker is
  present and `session_id` matches, rewrite `heartbeat_at`/`expires_at`, `200` plus lease JSON. If the
  marker is absent, or present under a different `session_id` (expired-and-reclaimed, or taken over),
  `409`; the client stops beating, warns "editing lease lost", and offers re-acquire.
- `POST /v0/workflows/lock/release` — free. Body `{ workflow_path, session_id }`. `200`, idempotent
  (already-gone is success). It deletes the marker only when `session_id` matches, so a stale beacon can
  never free someone else's lease.

All three are non-GET, so `enforceSameOrigin` gates them for CSRF exactly as it gates the write and run
routes (decision 8). A path that escapes the project root is a `404`, folded into the write route's
existing escape class.

**Timing: heartbeat every 10s, TTL 30s, expiry after 3 missed beats.** A live tab beats three times per
lease window, so a user who pauses to read never loses the lease. A crash frees the file in ≤30s. A
sleep longer than 30s expires it, but the sleeper was not editing, and takeover recovers it.

**Reclaim is lazy, on access.** There is no startup sweep and no background reaper. The server evaluates
and reclaims an expired marker only when someone next tries to acquire *that* file. A stale marker for a
file nobody reopens simply sits on disk, ignored. It is gitignored (below), so it never dirties `git
status`. A startup tree-walk would buy nothing the `.gitignore` entry does not already.

## Consequences

- **`.gitignore` gains `*.workflow.json.editing`.** The marker sits inside the project tree and would
  otherwise land in `git status` and be committed. It is added as part of this decision.
- **Discovery is already blind to the marker.** `scanWorkflowFiles`
  (`packages/server/src/routes/get-workflows.ts`) lists only names that end `.workflow.json`. The
  `.editing` suffix fails that test, and the scan also skips dot-dirs and symlinks. No discovery change
  is needed, confirmed against the code, not assumed.
- **Clean-close release is best-effort, and that is fine.** The Designer fires the release route from
  `beforeunload` via `navigator.sendBeacon`, which is POST-only, the reason all three routes are POST
  rather than a `DELETE`. If the beacon never lands (kill, crash, network), the TTL reaps the lease in
  ≤30s. The lease's *correctness* rests on the TTL, never on the beacon.
- **Takeover never reaches across to kill the other session.** An evicted session keeps running until
  its next heartbeat returns `409`. If it races a save in that window, ADR 0016's `If-Match`
  precondition, not the lease, rejects the stale write with a `412`. So the lease layer needs no
  cross-session signalling.
- **A lease is per file, and one session can hold several.** A `workflow` step's `ref` crosses to
  another file (decision 6), which carries its own precondition (#257) and its own lease. To drill in
  and edit a ref'd file acquires a second marker under the *same* `session_id`, beating independently. A
  `409` on the child is independent of the parent. What a session does with a still-dirty child lease on
  ascend is the dirty-state model's call (parked on #254), not this ADR's.
- **A brand-new, never-saved workflow holds no lease.** With no path yet there is no marker location.
  The client acquires only after the first save's write succeeds and a path exists. The existing-file
  flow is acquire-on-open, then heartbeat, then save (precondition), then release-on-close.

## Considered options

- **A bare presence marker, created on open and deleted on close (rejected).** It is the simplest, but
  its dominant failure is a file locked forever after any crash, sleep, or force-quit, exactly the case
  a browser cannot clean up. The lease's expiry converts that into a bounded ≤-TTL failure.
- **An in-memory lease registry in the server (rejected).** It would lose every lease on restart and
  force a rebuild-from-disk step anyway. To make the on-disk marker *the* state removes the second
  representation and makes restart a non-event.
- **Heartbeat riding the existing SSE hub (rejected).** `RunEventHub`
  (`packages/server/src/run-event-hub.ts`) is keyed by `root_run_id` and driven by run lifecycle.
  File-scoped leases have no run, and SSE flows server-to-client while a heartbeat flows
  client-to-server. To reuse it means to build a parallel file-scoped channel for the wrong direction. A
  dedicated POST is the right shape and couples to nothing.
- **A client-set `expires_at` (rejected).** It lets a buggy or hostile client pin a lease forever. The
  server computes expiry from its own clock; the client supplies only its opaque `session_id`.
- **`409` for a failed write precondition (rejected upstream, noted for consistency).** #258's issue
  floated `409` for the lock. ADR 0016 uses `412` for the *byte* precondition (idiomatic for a failed
  `If-Match`). This ADR keeps `409` only for the *lease* conflict (a live holder), where no conditional
  header is in play. The two codes name two different collisions.
