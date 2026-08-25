# PATH Designer Specification (draft)

This is the destination artifact of [Wayfinder map #254](https://github.com/howardyang2009/PATH/issues/254).
It is the **`@path/designer`** authoring console: the surface where a workflow is *authored*, as against
`@path/viewer` where runs are *watched*. This document is **under construction**. The map assembles it
section by section as each decision ticket closes. It is normative only for the sections present.
Sections not yet written are open tickets on #254.

**How to read this document.** The vocabulary follows [CONTEXT.md](../../CONTEXT.md). The server
endpoints it adds are contracted to the standard of [docs/api/server-api-v0.md](../api/server-api-v0.md)
and the [server API spec](./server-api-spec.md). Where a decision has an ADR, the ADR holds the
rationale and this spec states the contract. Where they disagree, the ADR wins on *why* and this spec
wins on *what the wire does*.

---

## Canvas interaction model

This section resolves [#255](https://github.com/howardyang2009/PATH/issues/255) and **amends map
decision 6**. It settled on the [`proto/designer-canvas-255`](https://github.com/howardyang2009/PATH/blob/proto/designer-canvas-255/packages/designer/canvas.prototype.html)
prototype (three variants: drill-down, inline-Scratch, hybrid). This section is normative.

### The model: inline within a file, drill-down across a ref boundary

Nesting **inside a single workflow file renders inline and visible**. Every node is a block. The three
block logicers (`parallel`, `branch`, `while-do`) are C-shaped wrappers. Their arms and body nest in
the mouth. This **supersedes** the pure level-by-level drill-down of decision 6's 2026-08-19 amendment.
The author sees a level's structure without a descent into it. The canvas drills in only one place: a
**`workflow`-ref crossing to another file**. That boundary already forces a separate write precondition
([#257](https://github.com/howardyang2009/PATH/issues/257)) and a separate edit lease (§ Edit-lock
lease protocol). Thus the navigation hop is not new cost.

The **constraint half of decision 6 is unchanged and tightened.** The palette offers only the block
kinds legal at a given socket. A block clicks into a socket **only** where the grammar allows it. An
illegal structure is *unsnappable*, not merely rejected on save. The author can never express a body
that the block grammar cannot: no edges, no arbitrary DAG.

### The block shapes the designer commits to

The canvas authors [`path/workflow@2`](../../CONTEXT.md)'s node shapes directly. The prototype pinned
these points that the UI must honour. Each matches the `@path/schema` types
([`node-type.ts`](../../packages/schema/src/node-type.ts)):

- **A `step` leaf is one of three worker types.** The executable leaf is a `PromptStep` (LLM — a
  `prompt` against a `model`), a `BinaryStep` (a `command` plus `args` plus `cwd`), or a `WorkflowStep`
  (a sub-workflow `ref`). All three share `id` and `name`. The `type` is a **creation-time**
  discriminant. To switch it would discard the payload. So the author chooses it up front; it is never
  a mutable dropdown. LLM and command share the step hue. The sub-workflow ref keeps its own hue,
  because it is the one boundary-crosser.
- **A `parallel` branch *is* a node.** `branches` is an array of `WorkflowNode`. Each carries its own
  `id` and `name`. A branch's **`name` is its `collect`/`wait-one` output key**. There is no separate
  branch label and no arm wrapper. To rename the branch renames the key.
- **A `branch` arm owns its `when`.** An arm is `{ when: Condition; node }`. The condition **belongs to
  the arm**, not to the Branch node. The Branch node owns only the **arm order** (first-match-wins) and
  the optional **`else`** fallback. An arm's occupant (and `else`'s) is a **single node**. Use a
  `sequence` where several are needed.
- **A `while-do` wraps one body node** (`node`). It carries a **mandatory `max_iterations`** bound
  (`number | string`; the string form is an `$env`/`$secret` reference). Both the loop `condition` and
  the cap are required. No unbounded loop is expressible.
- **Conditions are the structured [`Condition`](../../packages/schema/src/condition-type.ts) AST**,
  never free text. Leaf predicates (`exists`, `equals`, `one-of`, `matches`, `range`, `valid-json`)
  read a `context.` or `output.` dot-path. `all`, `any`, and `not` compose them. The pane authors them
  with a typed builder (pick operator, path, and operands). Thus an ill-typed or unparseable condition
  is unrepresentable, the structural analogue of the unsnappable socket. This governs **every**
  condition: a branch arm's `when`, a `while-do`'s `condition`, and a `checkpoint`'s assertion.

**Node identity** is the pair from
[ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md): a durable **`id`**
(client-minted UUIDv4, stable across rename, reorder, and reparent) and a human **`name`** (unique in
the file; the parallel output key above). Both are edited in the pane. To re-key the `id` is a
deliberate, **confirmation-gated** action, because it breaks resume's plan-reuse match for that node.

### Structure on the canvas, content in the pane

The governing split, and the rule that fixes where every affordance lives:

- **The canvas edits *structure*** — a node's place in the tree: **add**, **delete**, **reorder**,
  **replace** a single-slot occupant, add or remove a branch, arm, or `else`, **select**, and
  **descend**.
- **The properties pane edits *content*** — a node's own fields: `name`, `id`, `payload`, the parallel
  **join mode**, an arm's **`when`**, a loop's **`condition` and `max-iterations`**, a checkpoint's
  **assertion**, and a `workflow`-ref's **target path**.
- **The canvas may *show* content read-only** — a `join:` badge on the parallel hat, and the plain-text
  condition summary on a branch arm, a `while-do`, or a `checkpoint`. But it never *edits* content
  there. In the pane, a condition edits inside a labelled **`when`** or **`condition`** fieldset (the
  label on the border). The fieldset encloses the typed builder.

**Selection.** A single-click **selects** a node and populates the pane. A click on empty canvas
deselects, and the pane shows the current **file's** own properties. A `workflow`-ref is the one node
whose **single-click** selects it (the pane then edits **which file it references**) and whose
**double-click descends**. On descend, the canvas swaps to the ref'd file's body, and a **file
breadcrumb** tracks the crossing. (The trail is a navigation stack, not a tree parent: a ref'd file can
have several parents.) Blocks within a file are never descended into; they are already open.

**Pane layout.** The pane reads top-to-bottom, **orientation before editing**. First, the node's
**role**, when an occupant-of gives it one: `branch arm (N of M)`, `branch else fallback`, `parallel
branch`. Second, any **explanatory copy** for the kind, gathered into one block rather than scattered
per field. Then a divider, and third, the **editable fields**: `name` first, then the `id` (its re-key
button on the same row, the change confirmation-gated), then the kind-specific fields. Explanation and
role lead, so the author knows *what they are editing* before the inputs. A plain node with neither
opens straight at the fields.

### Per-kind rendering and edit affordances

| Node | Renders on the canvas as | Read-only on the block | Edited in the properties pane |
|---|---|---|---|
| `step` — LLM (`prompt`) | a leaf block, `LLM` chip | name | `name`, `id`, **`model`**, **`prompt`** |
| `step` — command (`binary`) | a leaf block, `COMMAND` chip | name | `name`, `id`, **`command`**, **`args`**, **`cwd`** |
| `step` — sub-workflow (`workflow`) | a chip, not an inline body — its own hue | the ref path | `name`, `id`, the **referenced file path**; double-click descends across the boundary |
| `checkpoint` | a leaf block **inline in the sequence**, between nodes — never attached to a node | `assert <cond>` summary | its **assertion** (structured `Condition`); a judgement check is a step that outputs a verdict + a checkpoint that tests it (judge-step pattern) |
| `parallel` | a C-block; its N branches side by side in the mouth | `join:` badge; each branch captioned, labelled by its own node name | **join mode** (`collect` / `wait-one` / `do-not-wait`) |
| `branch` | a C-block; its N arms side by side, then `else` | `when <cond>` summary per arm head (first-match-wins) | each arm's **`when`** (selected on the arm's own node); the Branch node itself edits only structure |
| `while-do` | a C-block wrapping one body node | `while <cond> · max N` summary | the loop **`condition`** and the **mandatory `max-iterations`** — exceeding it fails the run |
| `sequence` | a vertical stack in the mouth | length | `name`; **order is structure** (below) |

### Adding, reordering, deleting, and the empty canvas

All four are **canvas** actions (structure), never pane controls:

- **Add** — drag a palette block into a **legal socket**, or use a sequence's tail add-affordance. The
  socket accepts only grammar-legal kinds. The palette is **grouped into Steps** (the three leaf worker
  types: LLM, command, sub-workflow) **and Blocks** (the logicers plus checkpoint). Each step type is
  its own entry, so the author picks the worker up front. A branch whose `else` was deleted offers an
  **add-`else`** affordance (there is at most one `else`).
- **Reorder** — move-up or move-down (or drag) **within** a container. A move never changes a node's
  `id` ([ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)). Order is
  spatial and vertical.
- **Replace a single-node slot** — a `while-do` body, and a branch arm's or `else`'s occupant, are
  **one** node. You **swap** it: drop a block to replace the occupant, rather than empty the slot.
- **Delete** — the **× on a node** or the **Delete key**. Slot rules keep the tree legal. To delete a
  `while-do` body deletes the whole loop. The **last** parallel branch or branch arm cannot be deleted
  (a `parallel` or `branch` must keep ≥1). The **file-body root** is undeletable.

An **empty canvas** offers the palette plus a start-a-body affordance. A brand-new unsaved workflow
holds no lease until its first save (§ Session lifecycle).

### Still open (deferred to named #254 tickets)

These interact with this model but are **not** settled here: whether a `sequence` renders as its own
inline level or is collapsed; canvas validation-error UX (per-node markers vs a problems panel,
save-blocking vs save-with-warnings); undo/redo and the dirty-state model; new-file placement and
naming; and the `$env` / `$secret` authoring affordance. Each is an open ticket on
[#254](https://github.com/howardyang2009/PATH/issues/254).

---

## Edit-lock lease protocol

This section resolves [#258](https://github.com/howardyang2009/PATH/issues/258). The rationale is in
[ADR 0017](../adr/0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md). This section is
normative.

### Purpose and boundary

The edit-lock stops a **second Designer tab** from silently editing the same workflow file. It is
mutual exclusion between authoring sessions, surfaced *before* the first keystroke. It is not a
byte-level guarantee. Byte integrity is the write route's ETag `If-Match` precondition
([ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)). That
precondition covers every writer (editor, `git`, CLI, a second tab), and no lease can replace it. The
two are orthogonal, and both are required (map decision 10). A clean tab close releases the lease as a
courtesy. The lease's correctness rests on expiry, never on that release.

### The lease marker

A held lease is materialized as an on-disk file `<name>.workflow.json.editing` beside the workflow it
guards (map decision 12). It is JSON, authored by the server. It is the **single source of truth**. The
server keeps no in-memory lease registry. Thus a server restart neither loses nor rebuilds any lease:

```json
{
  "session_id": "3f2a…-uuidv4",
  "acquired_at": "2026-08-23T09:00:00.000Z",
  "heartbeat_at": "2026-08-23T09:00:20.000Z",
  "expires_at":  "2026-08-23T09:00:50.000Z"
}
```

- `session_id` — a UUIDv4 minted **client-side** (per
  [ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)'s
  client-mints-identity stance). It is the only token a client presents to heartbeat, release, or take
  over. There is no holder or user field, because the server has no auth.
- `acquired_at`, `heartbeat_at` — ISO-8601 UTC, server-stamped.
- `expires_at` — server-computed as `heartbeat_at + TTL`. It is **never** read from the client.

`@path/client-core` presents these camelCase (`sessionId`, `expiresAt`, and so on) and translates at
the wire boundary, per [ADR 0013](../adr/0013-client-write-seam-camelcase-in-wire-out.md).

### Timing

| Parameter | Value |
|---|---|
| Heartbeat interval | 10s |
| Lease TTL (after last beat) | 30s |
| Missed beats before expiry | 3 |

A live tab beats three times per window. Thus a paused reader never loses the lease. A crash frees the
file in ≤30s. A sleep past 30s expires the lease, and takeover recovers it.

### Routes

All three routes are POST, so `navigator.sendBeacon` (POST-only) can drive release from `beforeunload`.
All three carry the `/`-bearing path as an opaque `workflow_path` body field, not a URL segment. All
three reuse the write route's resolve, confine, and symlink stance: a path that escapes the project
root is a `404`. All three are non-GET, so they pass through the origin gate `enforceSameOrigin` (map
decision 8). A cross-origin request is a `403`.

**`POST /v0/workflows/lock`** — acquire (and take over).

Request: `{ "workflow_path": "lib/draft.workflow.json", "session_id": "<uuidv4>", "takeover": false }`

| Condition | Response |
|---|---|
| No marker, or on-disk marker expired (`now > expires_at`) | `200` + lease JSON. Fresh grant via exclusive create (`wx`); reclaim overwrites. |
| Live marker held by a **different** `session_id` | `409` + body `{ "held_by_other": true, "expires_at": "…" }` — the UI shows the countdown and offers takeover. |
| `takeover: true` | Overwrites the live marker unconditionally, giving `200` + lease JSON. The UI gates this behind an explicit user confirmation. |
| Path escapes project root | `404` |

**`POST /v0/workflows/lock/heartbeat`** — renew.

Request: `{ "workflow_path": "…", "session_id": "<uuidv4>" }`

| Condition | Response |
|---|---|
| Marker present and `session_id` matches | `200` + lease JSON with a fresh `heartbeat_at`/`expires_at`. |
| Marker absent, or present under a different `session_id` (expired-and-reclaimed, or taken over) | `409`. Client stops beating, warns "editing lease lost", offers re-acquire. |

**`POST /v0/workflows/lock/release`** — free.

Request: `{ "workflow_path": "…", "session_id": "<uuidv4>" }`

Always `200`, idempotent (already-gone is success). It deletes the marker **only** when `session_id`
matches, so a stale beacon cannot free another session's lease. It is fired from `beforeunload` via
`sendBeacon`. If it never lands, the TTL reaps the lease.

### Takeover and the evicted session

Takeover is a forced acquire. It does **not** reach across to stop the other session. The evicted
session keeps running until its next heartbeat returns `409`. At that point it stops and warns. If it
races a save inside that window, the write route's `If-Match` precondition (ADR 0016) rejects the stale
write with a `412`. Thus the lease layer carries no cross-session signalling.

### Reclaim, restart, and housekeeping

- **Reclaim is lazy, on access.** There is no startup sweep and no background reaper. The server
  evaluates and reclaims an expired marker only when someone next acquires *that* file. A stale marker
  for a file that nobody reopens sits on disk, ignored.
- **Server restart is a non-event.** Markers outlive the process. Expiry is a wall-clock timestamp. The
  next acquire evaluates it. There is nothing in memory to rebuild.
- **`.gitignore`.** `*.workflow.json.editing` is ignored (added with this decision). Thus a marker
  never reaches `git status`.
- **Discovery is unaffected.** `GET /v0/workflows` lists only names that end `.workflow.json`. The
  `.editing` suffix fails that test (confirmed in `get-workflows.ts`). The scan already skips dot-dirs
  and symlinks. There is no discovery change.

### Session lifecycle

- **Existing file:** acquire-on-open (enter the file to edit, before the first keystroke), then
  heartbeat every 10s, then save (guarded by the #257 precondition), then release-on-close.
- **Brand-new, unsaved workflow:** holds **no** lease. With no path there is no marker location. The
  client acquires only after the first save's write succeeds and a path exists.
- **Across a `workflow`-ref boundary:** to drill in and edit a ref'd file (map decision 6) acquires a
  **second** lease under the same `session_id`. It beats independently. Its `409`s are independent of
  the parent's. What a session does with a still-dirty child lease on ascend is the dirty-state model's
  call (a separate #254 ticket), out of scope here.
