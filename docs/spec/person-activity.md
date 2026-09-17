# `person-activity` step type — feature spec

**Status:** Design signed off. Assembled from the resolved tickets and ADRs of map
[#461](https://github.com/howardyang2009/PATH/issues/461) (the `person-activity` step-type plugin).
The mechanism shipped across [#484](https://github.com/howardyang2009/PATH/issues/484),
[#485](https://github.com/howardyang2009/PATH/issues/485),
[#486](https://github.com/howardyang2009/PATH/issues/486),
[#487](https://github.com/howardyang2009/PATH/issues/487), and
[#488](https://github.com/howardyang2009/PATH/issues/488); this document is its normative account.

This spec is normative for the `person-activity` step type, the `awaiting` run status, and the Complete
route. It **cites** the ADRs for the decisions behind each part and does not restate their reasoning:
[ADR 0038](../adr/0038-awaiting-is-a-leaf-only-status-parents-do-not-propagate.md) (leaf-only status),
[ADR 0039](../adr/0039-complete-is-a-durable-engine-re-invocation-over-the-appendable-tree.md) (durable
re-invocation), [ADR 0040](../adr/0040-output-schema-is-json-schema-validated-with-ajv-from-the-current-file.md)
(`outputSchema` validation), [ADR 0041](../adr/0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md)
(replay-from-root, lease + CAS), and [ADR 0042](../adr/0042-awaiting-inside-parallel-joins.md)
(`awaiting` inside joins). The glossary is [CONTEXT.md](../../CONTEXT.md) §§ Person-activity, Awaiting,
Audit; the terms here are used exactly as it defines them, and nothing here contradicts it. The HTTP
route has its own reference in [server-api-v0.md §4.4](../api/server-api-v0.md); this spec is the
behavior, that section is the wire shape.

## 1. Summary

`person-activity` is a built-in **leaf** step type whose one worker parks the run on an **offline human
action** instead of computing an output. The worker returns `{ status: "awaiting" }`; the leaf holds
the non-terminal **Awaiting** status and the run suspends. A person later completes the offline activity
and presses **Complete** in the Viewer or Designer, submitting output data. The engine validates that
output against the node's `outputSchema`, writes it as the leaf's output blob, moves the leaf to
`succeeded`, and continues the run from there.

```
step  gather-signatures  (type: person-activity)
  description: "Collect the signed vendor contract for {{ config.vendor }}"
  outputSchema: { type: object, required: [contractUrl], properties: { contractUrl: { type: string } } }
  assignee: "legal-ops"
  → worker returns { status: "awaiting" }; the leaf parks, the run row persists, the engine tears down
  → days later: POST /v0/runs/:step_run_id/complete  { output: { contractUrl: "…" } }
  → output validated, leaf awaiting → succeeded, the run continues into the next step
```

The wait is **durable**, not a held process (§4). It may last days across engine restarts and deploys.

## 2. Plugin shape

The plugin folder is `packages/engine/step-plugins/person-activity/`, registered like `binary` and
`prompt`. It declares three type **fields** and one worker.

| Field          | Type                    | Required | Meaning |
|----------------|-------------------------|----------|---------|
| `description`  | interpolable string     | yes      | What the person must do. Interpolated against the run's config; shown in the surfaces (§7). |
| `outputSchema` | JSON Schema object      | no       | The shape the person's Complete output must satisfy. Omitted ⇒ any JSON output is accepted (ADR 0040). |
| `assignee`     | string                  | no       | Informational label for who the activity is for. **Not** enforced identity (§8). |

`config` is empty: the type carries no operator-overridable, inheritable data.

The type ships **one** worker, `person` (the default worker), whose `run` returns
`{ status: "awaiting", assignee }` and computes nothing else. It is a leaf step type — peer to `binary`
and `prompt` — so it never contains child steps. The worker sets `meters: false` and
`needsProcessorSlot: false`: an awaiting leaf holds no processor slot while it waits (CONTEXT.md
§ Person-activity). `assignee` rides the returned verdict so the audit record can name it (§8).

`outputSchema` is **author-supplied data inside `workflow.json`**, so it is JSON Schema, not Zod —
the one type whose schema field breaks the Zod convention PATH uses for its own internal shapes (ADR
0040). It serves two readers from the same file-sourced value: a **UI contract** (the surfaces build
the Complete form from it, §7) and a **validation contract** (Complete checks against it, §4.3).
`parse: "json"` is a no-op for this type, because a Complete body already carries a structured
`JsonValue`, not a stdout string.

## 3. The `awaiting` status

`awaiting` is a run status in the store enum (`pending`, `running`, `awaiting`, `succeeded`, `failed`,
`cancelled`), enforced by the `runs.status` CHECK constraint. It is **non-terminal**: `isTerminal`
returns `false` for it.

- **Leaf-only (ADR 0038).** Only a leaf-step run ever carries `awaiting`. A root run and every enclosing
  workflow-run stay `running` while a descendant awaits; `awaiting`-ness is never rolled up to a parent.
  A tree parked entirely on people still reads `running` at the root. A surface that wants to signal
  "nothing is executing" derives that from the child rows itself.
- **Distinct from `paused` (ADR 0038, ADR 0041).** `awaiting` is not debug's `paused` (waiting for a
  debugger, #419). `paused` is not a run status today; debug-stepping is deferred and shipped nothing.
  A run holds `awaiting` when it waits for a **person**. See §8 for what is out of scope here.
- **Allowed leaf transitions (ADR 0041).** `awaiting → succeeded` (valid Complete output),
  `awaiting → awaiting` (invalid output refused `400`; the leaf stays parked for a retry, ADR 0040),
  and `awaiting → cancelled` (Cancel). Never `awaiting → failed`: Complete always succeeds, and failure
  is Cancel.

The log narrates the entry with the `step-awaiting` event (§8).

## 4. Complete: a durable, appendable re-invocation

### 4.1 No held process (ADR 0039)

The engine does **not** hold a live process or an in-memory promise for the wait. The awaiting run
persists to the store (a `runs` row with `status = awaiting` and no output blob) and the engine may tear
down entirely. `awaiting` survives a restart **as a row**; a live tree does not. If a tree is never
Completed, Resume re-runs the step and it re-enters `awaiting` (§6).

### 4.2 Replay from the root (ADR 0041)

Completion is a **fresh engine invocation with its own entry point**, distinct from launch and from
Resume. On Complete the engine:

1. Acquires a single-writer **expiring store lease** on the **root** run (the ADR 0017 lease pattern).
2. **Replays the tree from the root**, reusing every `succeeded` node's output read-only and restoring
   every re-entered workflow-run's context — the same `planReuse` + restore-by-load primitives Resume
   uses. Replay-from-root is chosen over a targeted leaf-open because continuation in a nested tree is a
   stack unwind up to the root, which *is* the root walk (ADR 0041).
3. Reaches the parked leaf as the one non-terminal node, writes the person's output as that leaf's
   output blob, and transitions the leaf `awaiting → succeeded` under a **compare-and-swap**.
4. Continues the walk forward into the tail, **in the existing tree** — it does **not** mint a successor
   root the way Resume does. This is the narrow **appendable-tree exception** to the read-only-rows rule:
   the only writes that break read-only-ness are the leaf's status transition and its output blob.
   Successor appends, the monotonic `seq`, and `context.json` write-through are ordinary behavior of a
   still-`running` run resumed — the enclosing workflow-run was never terminal, so nothing was frozen.

**Idempotency is free** (the replay reuses every `succeeded` row and the stored leaf output, so no
re-submission); **crash-atomicity is not promised** (a crash between the leaf commit and the tail's end
strands a `running` tree, the same unrecovered failure mode as a crash mid-launch). ADR 0039's durability
promise is scoped to "a parked await survives restart and can still be Completed."

Complete must locate and **reload the current workflow file** by source-workflow identity — the same
requirement Resume carries. A moved file or relocated store must still resolve, or the replay cannot run.

### 4.3 Output validation (ADR 0040)

At Complete the re-invoked engine reads **this node's** `outputSchema` from the **current** workflow file
by node id, re-interpolates it against the run's config, and validates the submitted output with **ajv**.

- **Invalid** output is refused `400` with the ajv issues in `error.details`; the leaf stays `awaiting`
  and the person may resubmit corrected output to the same route.
- **Valid** output is written as the step's output blob and the leaf moves to `succeeded`.
- A node with **no** `outputSchema` skips validation and accepts any JSON output.

The schema is read from the current file, never snapshotted onto the run row: the current file is the
authority (Resume's standing stance). This accepts an **edit race** — an author who edits `outputSchema`
between park and Complete makes the person validate against the newer shape, which is a Viewer freshness
concern (the form should reflect the current node), not a validation defect. `ajv` is a dependency of
the validation site, `@path/server`.

### 4.4 The route (server-api-v0.md §4.4, #466/#485)

`POST /v0/runs/:step_run_id/complete`. The path names the **leaf** (a tree may hold several awaiting
leaves at once, §5); the server derives the root from it for the lease. The body is `{ output }` — no
status field. The order of operations is deliberate:

1. **Validate before the lease.** Resolve the id, reload the file, ajv the output against the node's
   `outputSchema`. Invalid ⇒ `400`, leaf untouched, **no lease taken** — so a bad submit never blocks a
   sibling.
2. **Then** take the per-root lease (`409` if already held), CAS the leaf `awaiting → succeeded`, write
   the output blob, and **drive the tail in the background**. A long tail must not hold the HTTP request.
3. Respond **`202`** carrying `{ step_run_id, root_run_id }` so the client watches the **root** SSE
   stream and follows the run forward.

**Error taxonomy:**

| Status | Cause |
|--------|-------|
| `400`  | Output fails the node's `outputSchema`; ajv issues in `error.details`; leaf stays `awaiting`. |
| `403`  | Origin gate rejects the request. |
| `404`  | Unknown `step_run_id`, or the recorded workflow file no longer exists on disk (replay cannot run without it). |
| `409`  | The leaf's status is not `awaiting` (a root run, a workflow-run, a non-awaiting leaf, or a double-submit — the message names the **actual** status); the per-root lease is held; a swapped file or a pre-#169 store (Resume's own refusals). |

A concurrent Complete against a held lease is **rejected `409`, never queued** — a queue would
re-introduce the held wait ADR 0039 removes; the person retries. Where a node id is gone or the node was
retyped mid-wait, the only exit is **Cancel**, which moves the leaf to `cancelled`.

## 5. Concurrency (ADR 0042)

Many `awaiting` leaves may coexist — a `person-activity` step in each of several parallel branches.
They complete in **any order**, and the root stays `running` throughout (ADR 0038). An `awaiting` leaf
inside a parallel branch is an **ordinary non-terminal branch member**: it invents no join special case,
and each join's existing resolution and cancellation rules reach it unchanged.

- **collect** waits for every branch; each awaiting branch resolves on its own Complete, and the join
  lands when the last resolves. A **sibling failure** fires the existing `sibling-failed` cancellation,
  which cancels the still-awaiting branches; a later Complete for a cancelled leaf lands `409`.
- **wait-one** races for the first branch to **succeed**. An awaiting branch is a live racer: it **wins**
  if its Complete lands before any sibling succeeds (losers cancelled `sibling-succeeded`), and it is
  **cancelled** (`sibling-succeeded`) if a sibling succeeds first — a cancelled branch publishes nothing.
- **do-not-wait** may hold a `person-activity` step **iff that step's publish set is empty** (the
  ordinary detached-branch rule, keyed on declared `publish` keys). A legal detached branch parked
  `awaiting` holds the enclosing workflow-run barrier open until the person Completes, so the root stays
  `running`; the block's own join still completed at once with output `{}`.

The **park-at-join** rule (ADR 0041) makes the tail run **exactly once** under parallel Completes: a
replay that reaches a still-`awaiting` sibling parks at the incomplete join and releases the lease;
whichever Complete last satisfies the join runs the shared tail. The per-root lease (not a per-leaf CAS
alone) is what stops the cross-leaf double-execution of that tail.

The tree's own transitions once a Complete drives it forward (ADR 0041): `running → succeeded` (tail all
succeeds), `running → failed` (a successor step or checkpoint fails), `running → running` with a new
`awaiting` leaf (a later `person-activity` step, or a park-at-join), and `running → cancelled` (operator
cancel). The appendable window opens at the first `awaiting` and closes the instant the tree reaches a
terminal status; a Complete on a terminal tree, or on a non-`awaiting` leaf, is rejected.

## 6. Resume

An `awaiting` step is non-terminal, so it is **never reused**. A branch parked `awaiting` and never
Completed is non-succeeded, so Resume **re-runs** it: the worker returns `{ status: "awaiting" }` again
and the branch parks fresh. A leaf whose Complete already landed is `succeeded`, so Resume reuses its
stored output like any succeeded node. For a `do-not-wait` detached branch this is ADR 0009's re-fire
with no short-circuit, now stated for the awaiting case.

## 7. Client surfaces (#470 verdict — variant B; #486, #487)

Both the **Viewer** and the **Designer** surface `awaiting`. The Designer reuses the Viewer's run panels
(ADR 0031), so there is one Complete form implementation, not two.

**Awaiting display (both surfaces).** An `awaiting` leaf shows a `⏳` glyph and a purple
(`--st-awaiting`) status pill in the run rail; the `assignee` shows as a chip; the interpolable
`description` shows as a callout in the detail panel. The root and parent stay `running` while a leaf
awaits (ADR 0038) — that is the record's status in the DB and never changes. Every read surface, however,
paints a **running run with an awaiting run below it** with the `awaiting` pill too, so a parked leaf is
visible without expanding the tree. This is a **view-only** derivation (`effectiveRunStatus`), shared by
all four surfaces — the runs list, the run-detail head, the run tree, and the node I/O head — so they
never disagree. It repaints the pill, nothing else: the run keeps no assignee chip, gets no Complete form,
and its record status stays `running`. The runs list holds only summaries for the runs it is not watching,
so it derives this only for the watched root (whose full tree it has); other rows show their record status.
The rail carries a **count badge** when several leaves await at once (parallel joins, ADR 0042).

**Complete (inline in the node I/O/C/E panel).** The awaiting step's detail panel shows the Complete
surface **inline**: the `description` callout, the `assignee` chip, the step's `outputSchema` (shown even
when empty, so the person sees the shape their output is checked against), and the form built from that
schema. A node with no `outputSchema` draws a single free-text control instead, which takes anything the
person types: JSON becomes its value, plain prose becomes a JSON string, and blank submits an empty
output. It never rejects, matching the server's "any JSON accepted" for a schema-less node. Field
validation is inline; the **Complete this activity** button calls
`POST /v0/runs/:step_run_id/complete` directly with the panel's output value. On `400` the step stays
`awaiting` for a retry and the server's field errors show in place. On `202` the client watches the root
SSE stream and the run continues to the next `awaiting` step or to completion. (An earlier build put this
form in a right-edge slide-over; it is now inline in the panel.)

**Designer authoring.** The `person-activity` node gets its own canvas identity — a distinct **teal** hue
and a **person glyph** — so it no longer falls back to the `--k-step` indigo shared with generic steps and
reads apart from `binary` and `prompt`. The node editor exposes the three fields: `description`
(interpolable text area), `outputSchema` (JSON Schema / raw JSON), and `assignee` (text input). When a
`person-activity` step is `awaiting` during a Designer run, the Designer run dock reuses the **same
inline Complete form** as the Viewer.

## 8. Audit (#488)

The engine emits observations and log events so an `awaiting` → Complete cycle is reconstructable from the
log alone.

- **Park.** When a leaf goes `awaiting`, the engine emits the `step-awaiting` log event carrying the node
  id and the interpolated `assignee` (`null` when the node named none). This is the one leaf-level entry;
  ADR 0038 adds **no** parent transition event and **no** `step-resumed` — a leaf only ever moves on to
  `step-finished`.
- **Complete.** Writing the person's output and moving the leaf `awaiting → succeeded` emits the ordinary
  **succeeded `step-finished`** for that leaf — Complete reuses the normal leaf-finish narrative rather
  than a new event type. The tail then narrates itself with the usual lifecycle events as the replay
  drives it forward.

Event types align with the audit model's existing vocabulary; no new observation exception is added for
context on the appendable tree (§4.2).

## 9. Out of scope

Recorded here so the boundary is explicit and does not have to be re-derived from the map:

- **Timeout / expiry** for an `awaiting` step (future v2). An awaiting leaf waits indefinitely; nothing
  auto-cancels it.
- **Identity-bound assignment enforcement.** `assignee` is an informational label, not enforced identity;
  enforcement needs a user model PATH does not have.
- **Notifications** to the assignee when a step goes `awaiting` (email, webhook) — not in v1.
- **`awaiting` × debug `paused` interaction** (#469, closed moot). There is no `paused` status and no
  Continue route to interact with today; debug-stepping is deferred, and if it is ever built the
  interaction belongs to that map.
