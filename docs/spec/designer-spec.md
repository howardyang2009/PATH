# PATH Designer Specification

This is the destination artifact of [Wayfinder map #254](https://github.com/howardyang2009/PATH/issues/254),
assembled by [#263](https://github.com/howardyang2009/PATH/issues/263). It is the **`@path/designer`**
authoring console: the surface where a workflow is *authored*, as against `@path/viewer` where runs are
*watched*. Every decision the map charted is settled and recorded here. This document is **normative**:
a build map is chartable from it without re-opening any decision below.

Five concerns this document originally deferred by name — canvas validation-error UX, the undo/redo and
dirty-state model, new-file placement and naming, nested-`workflow`-ref creation, and the `$secret`/`$env`
authoring affordance — are **now settled** in § Deferred authoring UX (resolves #384); the "Still open"
flags below point there. What remains deferred to the build (execution) map is the **Designer test
strategy** alone. Each concern is a named implementation concern, flagged in the section it touches, not a
decision this spec ducks.

**How to read this document.** § 0 lists the map's locked constraints — the frame every section below
respects, not re-litigated here. The vocabulary follows [CONTEXT.md](../../CONTEXT.md). The server
endpoints it adds are contracted to the standard of [docs/api/server-api-v0.md](../api/server-api-v0.md)
and the [server API spec](./server-api-spec.md). Where a decision has an ADR, the ADR holds the
rationale and this spec states the contract. Where they disagree, the ADR wins on *why* and this spec
wins on *what the wire does*.

---

## 0. Constraints (from the map, not re-litigated here)

These are [map #254](https://github.com/howardyang2009/PATH/issues/254)'s locked decisions. Every section
below rests on them. They are recorded, not re-argued; each names its ADR where one holds the rationale.

- **Destination is a spec + ADRs**, not the built Designer. #254 is a planning map; construction is a
  separate execution map, seeded by this document.
- **`@path/designer` is a separate package**, peer of `@path/viewer`, with its own bundle and mount and
  not folded into it
  ([ADR 0028](../adr/0028-designer-is-a-separate-package-not-a-viewer-route.md)). It **depends on
  `@path/viewer` and reuses the Viewer's three run read panels** — the run list, the run detail, and the
  node I/O — parametrised for the Designer's scope
  ([ADR 0031](../adr/0031-designer-reuses-the-viewers-run-panels.md)). It keeps only its own run
  *authoring* chrome — the save-first launch form and the canvas projection. This partly restores map
  [#40](https://github.com/howardyang2009/PATH/issues/40)'s "reuses this viewer as a component" for the
  run read surfaces, while the authoring canvas stays Designer-only.
- **The authoring model is a constrained node canvas**, not a form tree and not a JSON editor. The author
  can never express a structure the block grammar cannot; a workflow body is an ordered tree of
  [`path/workflow@2`](../../CONTEXT.md) nodes, never an arbitrary DAG. Extending the format to a real DAG
  is rejected ([ADR 0029](../adr/0029-designer-canvas-is-the-block-grammar-no-arbitrary-dag.md)).
- **Authored workflows are saved through the server**, via `PUT /v0/workflows`
  ([server-api-v0.md §7](../api/server-api-v0.md#7-put-v0workflows--write-a-workflow-file),
  [ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)) — not
  browser-download-and-drop-it-in-yourself. The write reuses `prepareWorkflow`'s resolve/confine/symlink
  stance (decision 7), and the origin gate `enforceSameOrigin` guards it (decision 8,
  [#237](https://github.com/howardyang2009/PATH/issues/237)).
- **The edit-lock is a server-owned expiring file lease**
  ([ADR 0017](../adr/0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md)). It **complements**
  the write precondition; it does not replace it — the lease stops a second Designer tab, the ETag
  `If-Match` precondition protects the bytes against every writer (decision 10). Its marker sits beside
  the file as `<name>.workflow.json.editing` (map decision 12); `.gitignore` ignores
  `*.workflow.json.editing` so the marker never reaches `git status` (ADR 0017).
- **`$env` is permitted inside an authored workflow file.** ADR 0012 restricts `$env` only in *operator
  override config*, a different door; a `$env` wrapper authored inside a `workflow.json` is untouched
  ([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md), stated so it does not read as a
  regression).
- **Node identity is client-minted and save-preserving.** The client mints each `id` (UUIDv4) at
  node-create time; the server validates shape and confinement and never generates or rewrites one; a
  save preserves every `id` across rename, reorder, and reparent
  ([ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)).
- **One origin, two named mounts.** `path-server` serves both bundles from one origin: the Viewer at
  `/viewer/`, the Designer at `/designer/`, with bare `/` a 302 to `/viewer/` (decision 13,
  [ADR 0027](../adr/0027-two-bundles-one-origin-named-mounts-with-root-redirect.md)). Not two ports: the
  whole no-auth, localhost-bind, no-CORS, #237-origin-gate posture rests on a single origin.
- **Shared logic travels through `@path/client-core` only** (decision 14). Logic that must not diverge
  between surfaces moves *into* client-core; React components are not shared, because the surfaces are
  meant to look different.
- **The step palette is registry-driven.** The Designer receives a step-plugin registry as data
  ([server-api-v0.md §8](../api/server-api-v0.md#8-get-v0step-plugins--the-authoring-registry)) and the
  canvas **refuses to open** a file naming a step type absent from that registry
  ([ADR 0026](../adr/0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md),
  [ADR 0018](../adr/0018-open-node-union-via-pure-registry-factory.md)).

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

- **A `step` leaf is one of the registry's leaf step types.** `prompt` (LLM — a `prompt` against a
  `model`), `binary` (a `command` plus `args` plus `cwd`), and `workflow` (a sub-workflow `ref`) are
  the three the Designer ships a hand-built editor for; they are two step-type plugins plus the
  workflow-ref, not a closed set (CONTEXT.md § Step-type plugins). The palette is **registry-driven** —
  it holds one entry per leaf type the received registry describes, and any other type gets a generic
  editor (§ The v1 authoring palette). All leaf types share `id` and `name`. The `type` is a
  **creation-time** discriminant — not a **worker**, which is a per-step selector by name (below). To
  switch the type would discard the payload, so the author chooses the **type** up front; it is never a
  mutable dropdown. LLM and command share the step hue. The sub-workflow ref keeps its own hue, because
  it is the one boundary-crosser.
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
  socket accepts only grammar-legal kinds. The palette is **grouped into Steps** (one entry per leaf
  step type the registry describes — `prompt`, `binary`, `workflow`, and any plugin type such as
  `api-call`) **and Blocks** (the logicers plus checkpoint). Each step type is its own entry, so the
  author picks the **type** up front (the worker is a later per-step selection, § The v1 authoring
  palette). A branch whose `else` was deleted offers an **add-`else`** affordance (there is at most one
  `else`).
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

### Settled below (was: still open)

These interact with this model and are now settled in **§ Deferred authoring UX (resolves #384)**:
canvas validation-error UX (per-node markers **and** a problems panel; save-with-warnings; launch badged,
not blocked); the undo/redo and dirty-state model (clean = content-equality to the baseline,
[ADR 0030](../adr/0030-clean-is-content-equality-to-the-save-point-baseline.md)); new-file placement and
naming; nested-`workflow`-ref creation; and the `$env` / `$secret` authoring affordance. The `sequence` is
an explicit palette block rendering as its own inline stack (§ What is authorable), which resolves the
sequence-visibility question.

---

## The v1 authoring palette

This section resolves [#261](https://github.com/howardyang2009/PATH/issues/261). It extends the canvas
interaction model above with *what the palette can author* — the leaf step types, the control nodes,
their editors, and what the canvas does with a file it cannot render. The rationale for the last of
these (refuse-to-open) is in
[ADR 0026](../adr/0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md). This section
is normative.

### The palette is registry-driven

The step half of the palette is **not a closed set**. Leaf step types are step-type plugins (CONTEXT.md
§ Step-type plugins): `binary` and `prompt` are two folders under
`packages/engine/step-plugins/`, peers of any `api-call`, not a privileged pair. **Validity is
registry-relative** — a file is valid *against a registry*, never in the abstract
([ADR 0018](../adr/0018-open-node-union-via-pure-registry-factory.md)) — so the Designer, a pure browser
consumer that cannot scan the plugin folder, **receives a registry as data** and reproduces exactly the
grammar it describes. The palette therefore holds **one Steps entry per leaf step type the received
registry describes**, `prompt` / `binary` / `workflow` and every plugin type alike. The Blocks half is
fixed by the grammar (below).

The shape the palette consumes, per leaf type, is exactly ADR 0018's registry entry:
`{ name, fields, workers, defaultWorker }` — the type name (the palette label and the node's `type`
discriminant), the `fields` fragment (the generic editor's form spec), the type's worker `names`, and
which worker is the default. **The wire route that delivers this registry to the browser is
`GET /v0/step-plugins`** ([server-api-v0.md §8](../api/server-api-v0.md#8-get-v0step-plugins--the-authoring-registry)),
designed by the assembly ticket [#263](https://github.com/howardyang2009/PATH/issues/263) beside the
four client-core moves it carries (§ Run surfaces); its response is one snake_case entry per registered
step type. #261 fixed that the palette is registry-driven and the entry shape it needs; the route serves
that shape. The received registry is a **bare snapshot with no staleness contract** (ADR 0018
sub-decision 3): the write route re-validates every save against the server's **live** registry, so a
stale snapshot surfaces as a rejected write, never a corrupt file.

### What is authorable: the whole grammar, nothing deferred to JSON

Every node kind is a palette entry. Nothing is v1-deferred to hand-editing the JSON.

- **Steps** — one entry per registry leaf type (above).
- **Blocks** — the four logicers and the checkpoint: `parallel` (with its `collect` / `wait-one` /
  `do-not-wait` join modes), `branch`, `while-do`, `sequence`, and `checkpoint` (CONTEXT.md
  § Composition). `sequence` is an **explicit** palette block the author places, and it renders as its
  own inline stack (this resolves the map's open "sequence visibility" question toward *its own level*,
  not a collapsed one). The block grammar still governs where each snaps — an illegal structure is
  unsnappable, not merely rejected (§ Canvas interaction model).

### Editors: first-class, generic, and the raw-JSON floor

A step type's properties-pane editor is one of three tiers, and the tiers form a total order — **every
registry type always opens**:

| Tier | Applies to | The editor |
|---|---|---|
| First-class | `prompt`, `binary`, `workflow` | The hand-built editors of § Canvas interaction model (`model`+`prompt`; `command`+`args`+`cwd`; the referenced file path). |
| Generic | any other registry type (e.g. `api-call`) | A typed form **generated from the type's `fields` fragment** — one control per field, typed by the fragment. |
| Raw-JSON floor | any type whose `fields` a form cannot lay out | A single **live-validated JSON textarea** for the node's payload. |

The raw-JSON floor is what makes "registry-driven" a guarantee rather than a hope: the worst case for an
in-registry type is a validated JSON box, never a blocked node. The node stays strict-valid in every
tier — only the form's fidelity degrades. The clean line the palette draws: **a type present in the
registry always opens; a type absent from it refuses the file** (§ Opening a file the palette cannot
render).

### Worker selection

A **worker** is not a palette entry and not the step type. It is a per-step selector **by name** among
the workers its type ships, and it **does not inherit** (CONTEXT.md § Core execution model, invariant
5). The pane exposes it as a **dropdown only when the type ships more than one worker** — the names and
the pre-selected default come from the registry entry's `workers` / `defaultWorker`. A single-worker
type shows no worker control at all; the step writes no `worker` field and takes the type's default.
This is the correction to any reading of § Canvas interaction model as "pick the worker up front": the
author picks the **type** at create time; the worker is a later, optional, per-step name selection.

### Config inheritance display

A step inherits config downward from the enclosing workflow unless it overrides it (invariant 5). The
config editor must let the author tell **mine from inherited without reading the parent**:

- An **inherited** key renders read-only and ghosted, captioned with its **origin** (`inherited from
  <workflow name>`).
- Editing an inherited key (or an explicit **Override** affordance) makes it **local** to the step.
- An **overridden** key renders solid, with a **revert-to-inherited** control that drops the local value
  and restores the inherited one.

Config is the operator-variable, inheritable datum; a **Type field** (`command`, `prompt`, `endpoint`)
is author-fixed on the node and does not inherit (CONTEXT.md § Data,
[ADR 0022](../adr/0022-config-vs-field-vs-input-line-for-a-step-type.md)). The two edit in distinct pane
regions, and only config carries the inherited/overridden distinction above.

### Input/output wiring

A step declares its one input object in the pane, **not as canvas edges** — decision 6 forbids any
structure the block grammar cannot express, and dataflow is a dot-path reference, not a drawn edge. The
input is an interpolable JSON object: `${…}` placeholders reference `context.` and `output.` dot-paths,
authored with **path autocomplete** and validated live by `checkInterpolationSyntax`
([`interpolation.ts`](../../packages/schema/src/interpolation.ts), `dot-path.ts`). An unclosed or
ill-typed placeholder is rejected in the pane — the structural analogue of the unsnappable socket and
the typed condition builder. There is no node-to-node wire on the canvas.

### Context reads and writes

Context is a per-workflow-run blackboard written from inside the run (CONTEXT.md § Data). On the canvas
it is **invisible plumbing**, not drawn structure:

- A read is an ordinary `${context.x}` interpolation in an input or a condition (above).
- A write is the step's `publish` (and `parse`) — **pane fields on the step**, not canvas edges.

The one concession to visibility: a **publish conflict** the load-time checks reject — a `collect`
same-key sibling race, or a non-empty publish set on a `do-not-wait` branch (CONTEXT.md § Publish set) —
surfaces as a **node validation marker**, because it is a load error the author must see. Drawing
context as edges would re-introduce the DAG the format rejects.

### Opening a file the palette cannot render

Under a registry-driven palette every leaf type the registry describes opens (three tiers above), so
the only unrenderable node is one whose `type` is **absent from the Designer's received registry** — a
stale snapshot, or a cross-fork file this tree holds no plugin for (which the server itself reports
`valid: false`, CONTEXT.md § Discovery). The canvas **refuses to open** such a file. It does not open it
read-only, and it does not box the unknown node as an opaque round-trip node.

The refusal is **legible and recoverable**: it names **every** absent type in one message and the
`packages/engine/step-plugins/<name>/` folder that would resolve each — mirroring ADR 0018
sub-decision 5's aggregate load error — and, because the same-registry-source makes a stale snapshot the
only in-fork cause, it offers **refresh-the-registry-and-retry**. This matches ADR 0015's
refuse-on-structural-defect precedent (a duplicate or malformed `id` refuses the open) and the server's
own `valid: false` verdict. The rationale — why not read-only, and why not an opaque round-trip node —
is [ADR 0026](../adr/0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md).

### Settled below (was: still open)

The canvas validation-error UX that the publish-conflict marker plugs into (per-node markers **and** a
problems panel; save-with-warnings; launch badged) and the `$env` / `$secret` authoring affordance for a
config value (map decision 9) are settled in **§ Deferred authoring UX (resolves #384)**. What stays an
execution-map implementation concern, not a spec decision, is the generic editor's per-field control
mapping — which `fields` fragment shapes render as which inputs.

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
  the parent's. On **ascend with a still-dirty child**, the Designer does **not** force-save: the child
  keeps its dirty buffer and its still-beating lease, and the breadcrumb returns to it (§ Nested
  `workflow`-ref creation). Each file carries its own buffer, baseline, lease, and undo stack
  ([ADR 0030](../adr/0030-clean-is-content-equality-to-the-save-point-baseline.md)).

---

## Run surfaces

This section resolves [#260](https://github.com/howardyang2009/PATH/issues/260). The rationale is in
[ADR 0025](../adr/0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md).
This section is normative.

### The shape of the decision

The Designer carries the **Viewer's seven run surfaces, each reshaped to the authoring loop** — not a
pared-down subset (map decision 2 already gives the Designer its own run/cancel/resume/detail surfaces;
the driving dev ruled the run *browser* stays too). The author's question is narrow — *I just changed
this workflow; does it work, and if not, which step broke and what did it see?* — and that narrowness
governs the **shape** of each surface, never its presence. The Designer never embeds or imports
`@path/viewer`; it re-authors the views over the shared core (§ Shared seam).

| # | Surface | In the Designer |
|---|---|---|
| 1 | List workflows (picker) | **Collapses to zero as a run surface.** The launch target is the file open on the canvas — no picker precedes a launch. File open/new-file is an authoring affordance (separate #254 ticket), not a run surface. |
| 2 | Launch the workflow being edited | **Yes, save-first.** Gated on a clean buffer (below). |
| 3 | Cancel a run in flight | **Yes.** Same two-step arm-then-confirm gesture; "Cancelling…" is a request, not a status. |
| 4 | Resume a failed/cancelled run | **Yes** (driving-dev call). Same optional config-override form as the Viewer. Authoring caveat below. |
| 5 | List runs of this workflow | **Yes, full history, scoped to the open workflow by `workflow_id`.** Not session-only, not cross-workflow. |
| 6 | Run detail + run tree | **Projected onto the canvas nodes + a run-inspector pane.** Not a separate Viewer-style tree pane alone. |
| 7 | Node input/output | **Yes**, in the inspector pane (surface 6), reached by selecting a run. |

### Launch is save-first

A launch runs the **bytes on disk**: `POST /v0/runs` names a `workflow_path`, and the server loads
*that file* through `prepareWorkflow` (`packages/server/src/launch.ts`, map decision 7), never the
client's in-memory buffer. Therefore:

- **Launch is disabled while the canvas buffer is dirty.** A dirty canvas offers a save affordance;
  the save goes through the write route under the held lease
  ([ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md), §
  Edit-lock lease protocol). Launch enables once the buffer is clean.
- **"Clean" is the one save-point** the lease heartbeat and the `If-Match` precondition already use.
  The dirty-state/undo model defines it once for all three consumers: clean = the buffer's canonical
  serialization byte-equals the baseline the `If-Match` precondition carries (§ Dirty-state, undo, and the
  save-point; [ADR 0030](../adr/0030-clean-is-content-equality-to-the-save-point-baseline.md)).
- A **brand-new, unsaved** workflow cannot be launched: with no path there is nothing for
  `prepareWorkflow` to load. Its first save creates the path (§ Session lifecycle), after which launch
  behaves as above.

The launch form itself is the raw-JSON `input` (prefilled `{}`, empty allowed) plus an optional
`config` override, gated client-side by `parseJsonField` (now in `@path/client-core`, § Shared seam)
and validated server-side — a rejected `$env` override
([ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md)) or a schema failure returns a `400`
the form surfaces without collapsing.

### Cancel and resume

**Cancel** is the console's arm-then-send verb, unchanged in force: the first click arms, a second
within the arm window sends `POST` cancel, an idle arm disarms itself. A stray cancel destroys minutes
of paid, unrecoverable LLM work, so the gesture is deliberate. The look is the Designer's own.

**Resume** re-runs the predecessor's remaining steps as a successor
([ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md)), with the same optional config-override
form the Viewer offers and no `input` field (a resume restores context from the predecessor). One
**authoring caveat**, normative as a warning, not as new behaviour: resume matches nodes by
**plan-reuse against the predecessor's plan**, and after an edit the plan has moved — a resume across
an edit reuses **reuse rows** for nodes the author may have just changed. The Designer surfaces resume
and lets the author judge when it is meaningful; the plan-reuse semantics are the engine's existing
contract.

### Run list, scoped to the open workflow

The list is the Viewer's runs rail, **filtered to the workflow open on the canvas**. The scope key is
the workflow's **`id`**, not its `relative_path` — identity, not provenance
([ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)) — so a rename or a
moved file never splits the history.

This adds one optional query parameter to the list route, contracted in
[server-api-v0.md §3](../api/server-api-v0.md#3-get-v0runs--list-root-runs):

**`GET /v0/runs?workflow_id=<id>`** — the runs whose `workflow_id` equals `<id>`, most-recent-first,
composable with the existing `limit` and `status` filters. Omitted, the route is unchanged (every root
run, the Viewer's rail). The parameter is needed because the route returns a latest-N window: a
client-side filter over that window would miss older runs of the open workflow, so the full per-workflow
history must be a server-side filter. The response shape is the unchanged `ListRunsResponse`.

### Run detail: projected onto the canvas, inspected in a pane

The Designer canvas **is** a node view, so the run relates to it spatially in two coupled parts:

- **Projection.** Live run status **tints/badges the canvas nodes** as the run executes, off the same
  `connectRunViewModel` snapshot the Viewer's detail pane uses. This answers *where in my workflow is
  it*. It reads the folded SSE stream; it never opens a second connection.
- **Inspector pane.** A projection cannot be the whole surface, because **one node produces many
  runs** — a `while-do` iterates, a `parallel` fans out, a resume writes a **reuse row**, and a
  `workflow`-ref spawns a child run tree. A canvas node cannot show iteration 3 versus iteration 4. So a
  **run-inspector pane** holds the run tree (via `buildRunTree`) and, for a selected run, its node
  input/output/context (surface 7). This answers *which of this node's runs, and what did that one do*.

What is fixed here: **that** run status projects onto canvas nodes, and **that** an inspector pane
holds the tree and per-node I/O. What is **not** fixed here: the pane geometry (docked, floating,
overlaid), which the canvas-interaction prototype line (§ Canvas interaction model) resolves.

### Node input/output/context

The inspector's per-run block is the Viewer's node-I/O surface: the selected run's `input`, `output`,
and `context` blackboard objects, read over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`. The bytes
arrive already secret-masked (masking is a persistence-boundary concern, CONTEXT.md § Secret); the pane
renders what the server serves. What a **missing** object *means* — skip the read for a still-running
run with no ref, but read-anyway-and-trust-the-`404` for a terminal run (#51) — is the shared
blob-absence rule (§ Shared seam), not a per-surface judgment.

### Shared seam: what the Designer reuses, and what moves into `@path/client-core`

Per map decision 14, run-meaning that must not diverge between surfaces lives in `@path/client-core`;
React components do not. The Designer **reuses unchanged**: `RunViewModel`, `connectRunViewModel`,
`buildRunTree`, `eventOutcome`, `PathApiClient`, `subscribeRunEvents`, and the run wire types — the
watched-run connection, the event folding, the `Last-Event-ID` replay, and the tree shaping are already
surface-agnostic.

Four units that today sit inside `@path/viewer` as **framework-free logic** move **down** into
`@path/client-core`, because the Designer needs each and a second copy would drift:

| Moves into client-core | From | Why it must not diverge |
|---|---|---|
| `parseJsonField` (+ its result types) | `viewer/src/launch-json.ts` | The launch/resume `input`/`config` gate. One JSON-object contract, two forms. |
| `eventMessage` | `viewer/src/event-message.ts` | A `LogEvent`'s one narrative line — the textual sibling of `eventOutcome`, already shared. |
| `nodeLabel` / `nodeEventLabel` | `viewer/src/node-label.ts` | How a node is named (incl. the implicit-root null case), in the tree and the narrative. |
| the blob-absence rule | `viewer/src/use-run-blob.ts` | *What a missing input/output/context means.* The **decision** moves as a pure resolver; the `useState`/`useEffect` wiring stays per-surface. |

All four translate camelCase-in / snake-on-the-wire at the client seam
([ADR 0013](../adr/0013-client-write-seam-camelcase-in-wire-out.md)), matching the package's stance.

**Stays view** (each surface authors its own; decision 2 makes them look different): every `.tsx`
component (panes, forms, buttons, tree renderer); the status glyph and pill styling
(`status-glyph.ts`, the ordering included); the `Load<T>` phase union and hook wiring
(`load-state.ts`, `use-run-view.ts`) — the React binding of the already-shared `connectRunViewModel`,
not logic; and timestamp formatting.

## Deferred authoring UX (resolves #384)

The five concerns this document originally deferred by name — the dirty-state/undo model, new-file
placement and naming, nested-`workflow`-ref creation, the `$env`/`$secret` authoring affordance, and the
canvas validation-error UX — are settled here. They graduated from map #254 to
[#384](https://github.com/howardyang2009/PATH/issues/384) and were charted (grilling) before build. Each
was flagged "Still open" in the section it touches; this section is now normative for all five, and those
flags point here. The dirty-state model's rationale is in
[ADR 0030](../adr/0030-clean-is-content-equality-to-the-save-point-baseline.md); the other four carry
their rationale inline.

### Dirty-state, undo, and the save-point

Rationale: [ADR 0030](../adr/0030-clean-is-content-equality-to-the-save-point-baseline.md).

- **A buffer is *clean* when its canonical serialization is byte-identical to its *baseline*** — the
  on-disk bytes the client last synced, whose ETag the write route's `If-Match` precondition carries
  ([ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)). "Clean" is
  a **content comparison**, not a mutation flag. A save that returns `200` advances the baseline to the
  returned bytes/ETag; nothing else moves it. The serializer is canonical — stable key order, every `id`
  preserved ([ADR 0015](../adr/0015-designer-node-identity-client-mints-preserve-on-save.md)) — and is the
  same one the ETag hashes, so "clean" and "`If-Match` matches" never disagree.
- **One save-point, three consumers.** Launch enables only when the open file is clean (§ Launch is
  save-first); the `If-Match` precondition sends the baseline ETag; the **lease heartbeat is unconditional**
  — it beats every 10s regardless of dirtiness (§ Edit-lock lease protocol), because the lease guards
  authorship, not bytes. All three key off the **same baseline object**.
- **Undo/redo** is one entry per structural edit (add, delete, reorder, replace) or per **coalesced** field
  edit; scoped to the whole open file's tree. The stack **survives a save**: undoing past the save-point
  re-dirties the buffer, redoing back re-cleans it — a free consequence of content-equality, re-evaluated
  after every undo/redo. **Each open file — the parent and every descended ref child — has its own
  independent stack**, baseline, and lease; descent never merges stacks (a ref'd file has several parents;
  the breadcrumb is a navigation stack, not a tree parent). Redo is cleared by any new edit. This unlocks
  **Backspace-delete**, which `block-tree.tsx` withholds today for want of an undo.

### New-file placement and naming

A from-scratch workflow holds **no path and no lease** until its first save (§ Session lifecycle), so
placement is decided **at first save**, never at create.

- **Where.** The first save opens a dialog with a **directory picker confined to the project root** (the
  write route's resolve/confine/symlink stance,
  [ADR 0016](../adr/0016-workflow-write-route-client-named-put-upsert-precondition-gated.md); a path that
  escapes the root is a `404`). The default directory is the project root.
- **Name.** The filename is prefilled `<workflow.name>.workflow.json` — the workflow's `name`
  (`^[a-z][a-z0-9-]*$`, CONTEXT.md § Identity) slugs cleanly — and is author-editable, but the
  **`.workflow.json` suffix is enforced**, because discovery lists only that suffix (§ Edit-lock lease
  protocol, `GET /v0/workflows`).
- **Collision.** A new-file save is an **exclusive create**: an existing path is refused ("choose another
  name"), never a silent overwrite of another workflow. On success the path exists, the client acquires the
  lease, and launch behaves as for any saved file.

### Nested `workflow`-ref creation

The drill-down and the per-ref lease are built (§ Canvas interaction model, § Edit-lock lease protocol);
what was open is how a **new** ref target is created. Because a `workflow`-ref stores a **path**, adding a
ref offers **reference-existing** (a picker over discovered workflows) **or create-new**:

- **Create-new** runs the new-file dialog above to **choose the child's path** (directory picker + name +
  exclusive-create check), sets the parent ref to that path, then **descends into a fresh child buffer bound
  to that path but not yet written** — the from-scratch rule unchanged (no lease, no launch, until the
  child's first save), only the intended path pre-assigned. No stub file is written; the child is saved
  later with author-built content.
- The parent ref is **dangling** (its target file is absent) until the child's first save; that transient
  state surfaces as a validation marker (below), not a hard error.
- **Ascend with a dirty child does not force-save.** The child keeps its dirty buffer and its still-beating
  lease; the breadcrumb returns to it. The parent cannot *launch* until the child is saved (the server's
  `prepareWorkflow` cannot load a missing ref), which is correct behaviour, not a block the Designer adds.

### `$env` / `$secret` authoring (map decision 9)

The affordance lives **only where a wrapper is representable**: on **config** values (a **Type field** holds
no `$env`/`$secret` wrapper, [ADR 0022](../adr/0022-config-vs-field-vs-input-line-for-a-step-type.md) §6;
CONTEXT.md § Data) and on `while-do`'s `max_iterations` string form (§ The block shapes).

- **Entry.** A per-config-value **mode selector** — `Literal` / `$env` / `$secret`. `$env` reveals an
  env-var-name input; `$secret` reveals the secret-ref form (composing as `{"$secret": {"$env": …}}` is
  allowed, CONTEXT.md § Audit). It edits in the **config region** of the pane (§ Config inheritance
  display), not the type-field region.
- **Display is reference-only, never resolved.** An `$env` value shows the variable name as a chip
  (`$env · OPENAI_KEY`); a `$secret` shows a masked, named token. The Designer **never resolves** a wrapper
  — resolution is the engine's, at run-start (CONTEXT.md § Audit,
  [ADR 0012](../adr/0012-operator-config-rejects-env-wrapper.md)). A `$env` authored inside the file is
  permitted (§ 0 Constraints); this is the surface that authors it.
- **Validation is wrapper-shape only.** Config is validated *after* resolution against the resolved type
  ([ADR 0022](../adr/0022-config-vs-field-vs-input-line-for-a-step-type.md) §3–4), so the Designer cannot
  type-check the resolved value; a resolved-type mismatch (or an unset variable) surfaces at **run-start**,
  as the run's own error, not in the pane.

### Canvas validation-error UX

The canvas already makes illegal structure **unsnappable** (§ Canvas interaction model) and the pane
**refuses to commit** a schema-invalid node edit (`safeParseWorkflowFile` in the pane), so the errors that
survive to a whole-file view are dominantly **cross-node**: a dangling `${context.…}` / `${output.…}`
interpolation target, a dangling condition path, a dangling `workflow`-ref (above), and the publish
conflicts already surfaced today (§ Context reads and writes).

- **Two coupled surfaces.** A per-node **⚠ marker** on each offending node (the existing publish-conflict
  marker, extended to every cross-node error), **and** an aggregate **problems panel** listing each error
  with jump-to-node — because a marker on a collapsed or off-screen node is invisible, and a panel alone
  makes the author hunt. This mirrors the aggregate load error of
  [ADR 0018](../adr/0018-open-node-union-via-pure-registry-factory.md) §5 and the aggregate refuse-message
  of [ADR 0026](../adr/0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md).
- **Save-with-warnings.** A **hard** (schema-invalid) file is already blocked by the write route's
  server-side re-validation (a `400`, surfaced in the panel) and is largely unsnappable to begin with. The
  remaining **soft** cross-node errors **do not block save** — an author routinely writes a consumer before
  its producer, and nested-ref create-new *requires* it (a freshly created child ref is dangling until the
  child is saved; a save-block would deadlock the parent-then-child order).
- **Launch is badged, not blocked.** A saved-with-warnings file is *clean*, so launch is enabled; the launch
  button carries a **warning count** so the author launches knowingly, and the run surfaces the truth at
  run-start (an unresolved interpolation, an unset `$env`). This matches
  [ADR 0022](../adr/0022-config-vs-field-vs-input-line-for-a-step-type.md) (config/interpolation failures
  are run-start errors by design) and ADR 0025's stance that the author judges when a run is meaningful.

---

## Serving mounts and navigation

Both bundles are served from **one origin** by `path-server` (map decision 13: the no-auth,
localhost-bind, no-CORS, [#237](https://github.com/howardyang2009/PATH/issues/237)-origin-gate posture
rests on a single origin). This section fixes the mount layout, how the server learns the second
bundle, the two-app SPA fallback, the Vite dev shape, and the (absence of a) cross-surface link.
Rationale lives in [ADR 0027](../adr/0027-two-bundles-one-origin-named-mounts-with-root-redirect.md);
this section states the contract.

### Named mounts and the root redirect

The Viewer mounts at **`/viewer/`**, the Designer at **`/designer/`**. Neither holds the bare root.
A GET to **`/`** returns a **302** to `/viewer/` — the run-watching surface is the default. The 302 is
deliberate (not 301), so the default target stays changeable without a cached permanent redirect. Any
other non-`/v0`, non-prefixed path (for example `/foo`) is a plain **404**; the Viewer is router-less,
so there are no bare deep-links to preserve.

### How the server learns the two directories

`startPathServer` gains a second static-dir parameter beside the existing one:

- the Viewer dir (today's `staticDir`, default `packages/viewer/dist`) — now mounted at `/viewer/`;
- a new **`designerStaticDir`** (default `packages/designer/dist`) — mounted at `/designer/`.

Two hardcoded mounts, **not** an open mount table: the map fixes exactly two. Both defaults resolve
relative to the server package, as `DEFAULT_STATIC_DIR` already does.

### Prefix routing and the per-mount SPA fallback

A non-`/v0` GET is routed by **path prefix**:

- `/viewer/*` → the Viewer mount; the `/viewer` prefix is **stripped** and the remainder resolves
  within the Viewer dir. `/designer/*` → the Designer mount, `/designer` stripped likewise.
- Each mount keeps its **own** SPA fallback: an unmatched path under `/designer/*` serves the
  **Designer's** `index.html`, an unmatched path under `/viewer/*` the **Viewer's** — never the other
  bundle's.

This is a change to `serveStatic`'s current assumption. Today it joins the **full** pathname against
one root dir; under two mounts it must join the **suffix after the mount prefix**, so `/designer/assets/x.js`
resolves to `<designerDir>/assets/x.js`. Bare `/designer` and `/designer/` both map to the Designer's
`index.html` (same for `/viewer`).

`/v0/*` is unchanged: its unmatched routes keep their JSON 404s, never SPA HTML.

**Unbuilt bundles degrade, they do not crash.** Each mount's `serveStatic` already returns `false`
(falling through to a 404) when its dir or `index.html` is missing. So a Designer that was never built
404s under `/designer/*` while `/viewer/*` still serves — and the same now holds for the Viewer,
because it too sits behind a named mount.

### Vite dev

Each bundle builds with a Vite **`base`** matching its mount, so built asset URLs resolve under the
prefix: the Viewer `base: "/viewer/"` (a change — it builds at root today), the Designer
`base: "/designer/"`. Both dev servers proxy `/v0` to `PATH_SERVER_URL`
(default `http://localhost:8787`), the shape the Viewer already uses. In dev the surfaces open at
`http://localhost:<viteport>/viewer/` and `.../designer/`.

Consequence to hold: anything that assumed `GET /` returns the Viewer's `index.html` — server
acceptance tests included — must move to `/viewer/` or follow the 302.

### No cross-surface link in v1

The Designer carries **all seven** of its own run surfaces (§ Run surfaces,
[ADR 0025](../adr/0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md)),
so "run this workflow" never has to leave the Designer. v1 therefore ships **no** navigation link
between the two surfaces and **no** run-scoped deep link: each surface is reached by its own URL. A
deep link (a root-run id in the Viewer's URL) would force a router onto the currently router-less
Viewer; that is a Viewer-router decision for a later ticket, not a serving decision here.

