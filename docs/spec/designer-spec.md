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

## Canvas interaction model

Resolves [#255](https://github.com/howardyang2009/PATH/issues/255) and **amends map decision 6**;
settled on the [`proto/designer-canvas-255`](https://github.com/howardyang2009/PATH/blob/proto/designer-canvas-255/packages/designer/canvas.prototype.html)
prototype (three variants: drill-down, inline-Scratch, hybrid). This section is normative.

### The model: inline within a file, drill-down across a ref boundary

Nesting **inside a single workflow file renders inline and visible** — every node is a block, and the
three block logicers (`parallel`, `branch`, `while-do`) are C-shaped wrappers whose arms/body nest in
their mouth. This **supersedes** the pure level-by-level drill-down of decision 6's 2026-08-19
amendment: the author sees a level's structure without descending into it. The only place the canvas
drills is a **`workflow`-ref crossing to another file** — a boundary that already forces a separate
write precondition ([#257](https://github.com/howardyang2009/PATH/issues/257)) and a separate edit
lease (§ Edit-lock lease protocol), so the navigation hop is not new cost.

The **constraint half of decision 6 is unchanged and tightened.** The palette offers only the block
kinds legal at a given socket, and a block clicks into a socket **only** where the grammar allows it —
an illegal structure is *unsnappable*, not merely rejected on save. The author can never express a
body the block grammar cannot: no edges, no arbitrary DAG.

### Selection and the properties pane

Single-click **selects** a node and populates a right-hand properties pane; clicking empty canvas
deselects and the pane shows the current **file's** own properties. A `workflow`-ref is the one node
whose double-click **descends** — the canvas swaps to the ref'd file's body and a **file breadcrumb**
tracks the crossing (the trail is a navigation stack, not a tree parent: a ref'd file may have several
parents). Blocks within a file are never descended into; they are already open.

### Per-kind rendering and edit affordances

| Node | Renders as | Where its controls live |
|---|---|---|
| `step` | a leaf block | payload in the properties pane |
| `checkpoint` | a leaf block **inline in the sequence**, between nodes — never attached to a node | its assertion in the pane; a judgement check is a step that outputs a verdict + a checkpoint that tests it (judge-step pattern) |
| `parallel` | a C-block; its N branches side by side in the mouth | **join mode** (`collect` / `wait-one` / `do-not-wait`) is a control on the block hat; each branch labelled by its node name |
| `branch` | a C-block; its N arms side by side | each arm's **condition** on that arm's head (first-match-wins; `else` is the fallback arm) |
| `while-do` | a C-block wrapping one body node | its **mandatory max-iterations** bound is a required field on the hat; exceeding it fails the run — no unbounded loop is expressible |
| `sequence` | a vertical stack in the mouth | **order is vertical position**; reordered by move-up/down (or drag) within the container; a legal drop-socket sits at the tail |
| `workflow` (ref) | a chip, not an inline body | double-click descends across the file boundary |

### Sequence order, adding, and the empty canvas

Order is spatial and vertical; reordering is a move **within** a container and never changes a node's
`id` (per [ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)). A node is
added by dragging a palette block into a legal socket, or via the sequence's tail add-affordance; the
socket accepts only grammar-legal kinds. An **empty canvas** offers the palette plus a start-a-body
affordance; a brand-new unsaved workflow holds no lease until its first save (§ Session lifecycle).

### Still open (deferred to named #254 tickets)

These interact with this model but are **not** settled here: whether a `sequence` renders as its own
inline level or is collapsed; canvas validation-error UX (per-node markers vs a problems panel,
save-blocking vs save-with-warnings); undo/redo and the dirty-state model; new-file placement and
naming; and the `$env` / `$secret` authoring affordance. Each is an open ticket on
[#254](https://github.com/howardyang2009/PATH/issues/254).

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
