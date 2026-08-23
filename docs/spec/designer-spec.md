# PATH Designer Specification (draft)

Destination artifact of [Wayfinder map #254](https://github.com/howardyang2009/PATH/issues/254) — the
**`@path/designer`** authoring console, the surface where a workflow is *authored*, as against
`@path/viewer` where runs are *watched*. This document is **under construction**: the map assembles it
section by section as each decision ticket closes, and it is normative only for the sections present.
Sections not yet written are open tickets on #254.

**How to read this document.** Vocabulary follows [CONTEXT.md](../../CONTEXT.md). Server endpoints it
adds are contracted to the standard of [docs/api/server-api-v0.md](../api/server-api-v0.md) and the
[server API spec](./server-api-spec.md). Where a decision has an ADR, the ADR holds the rationale and
this spec states the contract; where they disagree, the ADR wins on *why* and this spec wins on *what
the wire does*.

---

## Edit-lock lease protocol

Resolves [#258](https://github.com/howardyang2009/PATH/issues/258); rationale in
[ADR 0017](../adr/0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md). This section is
normative.

### Purpose and boundary

The edit-lock stops a **second Designer tab** from silently editing the same workflow file. It is
mutual exclusion between authoring sessions, surfaced *before* the first keystroke — not a byte-level
guarantee. Byte integrity is the write route's ETag `If-Match` precondition
([ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)), which
covers every writer (editor, `git`, CLI, a second tab) and which no lease can replace. The two are
orthogonal and both required (map decision 10). A clean tab close releases the lease as a courtesy;
the lease's correctness rests on expiry, never on that release.

### The lease marker

A held lease is materialized as an on-disk file `<name>.workflow.json.editing` beside the workflow it
guards (map decision 12). It is JSON, authored by the server, and it is the **single source of truth**
— the server keeps no in-memory lease registry, so a server restart neither loses nor rebuilds any
lease:

```json
{
  "session_id": "3f2a…-uuidv4",
  "acquired_at": "2026-08-23T09:00:00.000Z",
  "heartbeat_at": "2026-08-23T09:00:20.000Z",
  "expires_at":  "2026-08-23T09:00:50.000Z"
}
```

- `session_id` — a UUIDv4 minted **client-side** (per [ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)'s
  client-mints-identity stance). The only token a client presents to heartbeat, release, or take over.
  There is no holder/user field: the server has no auth.
- `acquired_at`, `heartbeat_at` — ISO-8601 UTC, server-stamped.
- `expires_at` — server-computed as `heartbeat_at + TTL`. **Never** read from the client.

`@path/client-core` presents these camelCase (`sessionId`, `expiresAt`, …) and translates at the wire
boundary, per [ADR 0013](../adr/0013-client-write-seam-camelcase-in-wire-out.md).

### Timing

| Parameter | Value |
|---|---|
| Heartbeat interval | 10s |
| Lease TTL (after last beat) | 30s |
| Missed beats before expiry | 3 |

A live tab beats three times per window, so a paused reader never loses the lease; a crash frees the
file in ≤30s; a sleep past 30s expires it and takeover recovers it.

### Routes

All three are POST (so `navigator.sendBeacon`, POST-only, can drive release from `beforeunload`), all
carry the `/`-bearing path as an opaque `workflow_path` body field (not a URL segment), and all reuse
the write route's resolve/confine/symlink stance — a path escaping the project root is a `404`. Being
non-GET, all three pass through the origin gate `enforceSameOrigin` (map decision 8); a cross-origin
request is a `403`.

**`POST /v0/workflows/lock`** — acquire (and take over).

Request: `{ "workflow_path": "lib/draft.workflow.json", "session_id": "<uuidv4>", "takeover": false }`

| Condition | Response |
|---|---|
| No marker, or on-disk marker expired (`now > expires_at`) | `200` + lease JSON. Fresh grant via exclusive create (`wx`); reclaim overwrites. |
| Live marker held by a **different** `session_id` | `409` + body `{ "held_by_other": true, "expires_at": "…" }` — the UI shows the countdown and offers takeover. |
| `takeover: true` | Overwrites the live marker unconditionally → `200` + lease JSON. The UI gates this behind an explicit user confirmation. |
| Path escapes project root | `404` |

**`POST /v0/workflows/lock/heartbeat`** — renew.

Request: `{ "workflow_path": "…", "session_id": "<uuidv4>" }`

| Condition | Response |
|---|---|
| Marker present and `session_id` matches | `200` + lease JSON with a fresh `heartbeat_at`/`expires_at`. |
| Marker absent, or present under a different `session_id` (expired-and-reclaimed, or taken over) | `409`. Client stops beating, warns "editing lease lost", offers re-acquire. |

**`POST /v0/workflows/lock/release`** — free.

Request: `{ "workflow_path": "…", "session_id": "<uuidv4>" }`

Always `200`, idempotent (already-gone is success). Deletes the marker **only** when `session_id`
matches, so a stale beacon cannot free another session's lease. Fired from `beforeunload` via
`sendBeacon`; if it never lands, the TTL reaps the lease.

### Takeover and the evicted session

Takeover is a forced acquire; it does **not** reach across to stop the other session. The evicted
session keeps running until its next heartbeat returns `409` — at which point it stops and warns. If it
races a save inside that window, the write route's `If-Match` precondition (ADR 0016) rejects the stale
write with a `412`. The lease layer therefore carries no cross-session signalling.

### Reclaim, restart, and housekeeping

- **Reclaim is lazy, on access.** No startup sweep and no background reaper. An expired marker is
  evaluated and reclaimed only when someone next acquires *that* file. A stale marker for a file nobody
  reopens sits on disk, ignored.
- **Server restart is a non-event.** Markers outlive the process; expiry is a wall-clock timestamp; the
  next acquire evaluates it. Nothing in memory to rebuild.
- **`.gitignore`.** `*.workflow.json.editing` is ignored (added with this decision), so a marker never
  reaches `git status`.
- **Discovery is unaffected.** `GET /v0/workflows` lists only names ending `.workflow.json`; the
  `.editing` suffix fails that test (confirmed in `get-workflows.ts`), and the scan already skips
  dot-dirs and symlinks. No discovery change.

### Session lifecycle

- **Existing file:** `acquire-on-open` (entering the file to edit, before the first keystroke) →
  `heartbeat` every 10s → `save` (guarded by the #257 precondition) → `release-on-close`.
- **Brand-new, unsaved workflow:** holds **no** lease — with no path there is no marker location. The
  client acquires only after the first save's write succeeds and a path exists.
- **Across a `workflow`-ref boundary:** drilling in to edit a ref'd file (map decision 6) acquires a
  **second** lease under the same `session_id`, beating independently; its `409`s are independent of
  the parent's. What a session does with a still-dirty child lease on ascend is the dirty-state model's
  call (a separate #254 ticket), out of scope here.
