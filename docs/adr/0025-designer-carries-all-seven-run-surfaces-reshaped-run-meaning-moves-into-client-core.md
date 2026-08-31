# The Designer carries all seven run surfaces, reshaped; shared run-meaning moves into `@path/client-core`

**Status:** accepted; resolves [#260](https://github.com/howardyang2009/PATH/issues/260), part of
Wayfinder map [#254](https://github.com/howardyang2009/PATH/issues/254). Applies map **decision 2**
(the Designer owns its own run/cancel/resume/detail surfaces, shaped differently from the Viewer's,
and does not embed or import `@path/viewer`) and map **decision 14** (shared logic travels through
`@path/client-core` only; React components are not shared). Builds on
[ADR 0013](0013-client-write-seam-camelcase-in-wire-out.md) (the camelCase-in / wire-out client
seam), [ADR 0015](0015-designer-node-identity-client-mints-preserve-on-save.md) (a node's `id` is the
durable identity, its `name` and file are provenance), [ADR 0016](0016-workflow-write-route-client-named-put-upsert-precondition-gated.md)
(the write route and its `If-Match` precondition), and
[ADR 0017](0017-designer-edit-lock-is-a-server-owned-expiring-file-lease.md) (the per-file edit
lease). The rationale is here; the wire and UI contract is in the **Run surfaces** section of
[docs/spec/designer-spec.md](../spec/designer-spec.md).

**Amends** nothing. It settles two questions map #254 left open: *which* of the Viewer's run surfaces
the Designer needs and in what shape, and *what* run-meaning currently living in `@path/viewer` React
code must move down into `@path/client-core` so the two surfaces cannot answer the same question two
ways.

## What #260 asked, and the answer the driving dev ruled

#260's framing hypothesis was that an author's question is narrow — *I just changed this workflow;
does it work, and if not, which step broke and what did it see?* — and that a run **browser** might
therefore be the Viewer's job alone, leaving the Designer a strict subset of the seven surfaces.

The driving dev ruled against the subset. **The Designer carries all seven surfaces**, each reshaped
to the authoring loop rather than dropped. This ADR records that reversal so a later reader does not
re-propose a pared-down Designer on the strength of #260's opening question. The narrowness of the
author's question governs the *shape* of each surface, not the *presence* of it.

## The seven surfaces, decided one by one

1. **List workflows (the picker).** Reshaped, not dropped. The Viewer's `launch-panel` discovers every
   workflow file (`GET /v0/workflows`) because the Viewer has no file open. The Designer always has the
   file it is editing open on the canvas, so its launch target is *that* file — no picker precedes a
   launch. Discovery still exists in the Designer as an authoring affordance (open-a-file, new-file
   placement — a separate #254 ticket), which is a file-navigation concern, not a run surface. As a
   *run* surface the picker collapses to zero: you launch the workflow you are editing.

2. **Launch a run of the workflow being edited.** Yes, and it is **save-first**. A launch runs the
   bytes on disk — the server loads the file through `prepareWorkflow`
   (`packages/server/src/launch.ts`, map decision 7), which resolves, confines, and parses *the file*,
   never the client's in-memory buffer. So a launch off a dirty canvas would run a stale version and
   silently answer the author's question about code they can no longer see. The Designer therefore
   **gates launch on a clean buffer**: a dirty canvas must save (through the write route and under the
   held lease, ADRs 0016 and 0017) before launch is enabled. This ties the run loop to the same
   save-point the lease and precondition already define, and needs no new server behaviour.

3. **Cancel a run in flight.** Yes, unchanged in force, restyled in look. The author launches a test
   run; if it hangs or goes visibly wrong, cancel. The two-step arm-then-confirm gesture and its
   "Cancelling… is a request, not a status" discipline (the Viewer's `cancel-button`) are the same
   here — a stray cancel still destroys minutes of paid, unrecoverable LLM work.

4. **Resume a failed or cancelled run.** Kept in the Designer (driving-dev call). The tension noted at
   decision time: resume re-runs the remaining steps by **plan-reuse** against the *predecessor's*
   plan, and after an edit the plan has moved, so a resume across an edit reuses rows the author may
   have just changed. The Designer does not suppress the surface; it carries the operator's resume verb
   (same optional config-override form as the Viewer) and lets the author judge when a resume is
   meaningful. Plan-reuse correctness is the engine's existing contract
   ([ADR 0001](0001-resumed-run-is-a-successor-run.md)); this decision adds no new resume semantics.

5. **List all runs of this workflow.** Kept as full history (driving-dev call), **scoped to the open
   workflow**. Not "only this session's runs" and not the Viewer's cross-workflow rail. The scope key
   is the workflow's **`id`**, not its path — identity, not provenance (ADR 0015) — so a rename or a
   moved file does not split the run history. This needs a small server-API addition: `GET /v0/runs`
   today filters only by `limit` and `status`, and returns a latest-N window, so a client-side filter
   over that window would miss older runs of the open workflow. A **`workflow_id` query parameter** on
   the list route makes the scoped history complete. The spec carries that contract; the assembly
   ticket carries the server change.

6. **Run detail + run tree — projected onto the canvas, inspected in a pane.** This is the surface
   most unlike the Viewer's. The Viewer draws an indented run tree in a separate pane because it has no
   node view of its own. The Designer canvas **is** a node view, so live run status **projects onto the
   canvas nodes** (a per-node tint/badge as the run executes). But a projection cannot be the whole
   surface: one node produces **many runs** — a `while-do` iterates, a `parallel` fans out, a resume
   writes a **reuse row** (CONTEXT.md, *Reuse row*), and a `workflow`-ref spawns a child run tree. A
   canvas node cannot show iteration 3 versus iteration 4. So a **run-inspector pane** holds the run
   tree and, for a selected run, its node I/O. The projection answers *where in my workflow is it*; the
   inspector answers *which of this node's runs, and what did that one do*. The exact geometry is a
   prototype call, flagged in the spec.

7. **Run input / output per node.** Yes, core to the loop — *which step broke and what did it see* is
   exactly a node's input, output, and context blackboard (the Viewer's `node-io`). Reshaped only in
   placement (it lives in the inspector pane of surface 6, reached by selecting a run), not in
   substance.

## The seam: what moves into `@path/client-core`, and what stays view

Map decision 14 draws the line: logic that must not diverge between surfaces moves *into* client-core;
React components do not move. `client-core` already holds the run-meaning that answers
"questions with one right answer" — `RunViewModel`, `connectRunViewModel`, `buildRunTree`,
`eventOutcome`. The Designer reuses every one of those **unchanged**: the watched-run connection, the
event folding, the `Last-Event-ID` replay, and the tree-shaping are surface-agnostic already, and a
second implementation of any of them would be a second run.

Four things the Designer needs still live as **framework-free logic inside `@path/viewer`**, wearing a
React file only by where they happen to sit. Each answers a one-right-answer question and each moves
down:

1. **`parseJsonField`** (`viewer/src/launch-json.ts`) — the client-side gate that proves a launch's
   `input`/`config` text is a JSON object before a request is spent, and shapes the `empty` vs
   `not-allowed-empty` distinction. It is pure TS over `JsonValue` and the launch and resume forms both
   call it. The Designer's launch and resume forms need the identical gate. **Move to client-core.**

2. **`eventMessage`** (`viewer/src/event-message.ts`) — the exhaustive mapping from a `LogEvent` to its
   one narrative line ("branch X took the else arm", "join Y applied · published …"). What a
   join/branch/cancel/reuse event *says* has one right answer, the textual sibling of `eventOutcome`
   (which already lives in client-core for exactly this reason). Two surfaces phrasing the same event
   two ways would narrate the same run differently. **Move to client-core.**

3. **`nodeLabel` / `nodeEventLabel`** (`viewer/src/node-label.ts`) — how a node is named from its
   `node_id`/`node_name`, including the implicit-root null case. Both surfaces must name the same node
   the same way, in the tree and in the narrative. **Move to client-core.**

4. **The blob-absence resolution** inside `useRunBlob` (`viewer/src/use-run-blob.ts`) — the rule that
   decides what a missing input/output/context object *means*: skip the read when a still-running run
   carries no ref, but read-anyway-and-trust-the-404 when the run is terminal (a terminal run's ref may
   be absent from a snapshot no tree read has refreshed since the object was written, #51). That rule is
   domain logic wearing a hook; a second surface reaching a different answer would call a live run's
   step "no output" or a finished run's step an error. The **decision** moves to client-core as a pure
   resolver; only the `useState`/`useEffect` wiring stays per-surface. **Move the rule down, leave the
   React binding.**

All of these translate camelCase-in / snake-on-the-wire at the client seam (ADR 0013), matching the
package's existing stance.

**What does not move** — it is view, and the two surfaces are meant to look different (decision 2):

- Every `.tsx` component (the panes, forms, buttons, the tree renderer, the launch/resume/cancel UI).
- The **status glyph and pill styling** (`viewer/src/status-glyph.ts`, `status-pill.tsx`). The glyph
  set and colour tokens are a look, and the Designer's pills deliberately differ. The *ordering*
  (`ORDERED_RUN_STATUSES`) is borderline — a filter's display order — but it is derived from the glyph
  map and reads as a view concern; it stays view unless a shared need for it later appears.
- The `Load<T>` phase union and the hook wiring (`load-state.ts`, `use-run-view.ts`) — the React
  binding of the already-shared `connectRunViewModel`, not logic. The Designer writes its own hooks
  over the same core.
- Timestamp formatting (`format-time.ts`) — presentation.

## Considered options

- **A pared-down Designer** carrying only launch + node I/O, delegating browse/resume to the Viewer
  (#260's opening hypothesis). Rejected by the driving dev: it would force the author out of the
  authoring surface to answer "has this ever worked, and how did the last run differ", and it fights
  map decision 2, which already gives the Designer its own run/cancel/resume/detail surfaces.
- **Embedding the Viewer's panes in the Designer** to get the seven surfaces for free. Rejected by map
  decision 2 (the Designer does not import `@path/viewer`) and by surface 6: the Designer's run detail
  is a *canvas projection*, a shape the Viewer's pane does not have and cannot be restyled into.
- **Extracting a shared `@path/ui` React package** for the buttons and forms both surfaces reuse.
  Rejected by map decisions 5 and 14 and out of scope on #254: the surfaces are meant to look
  different, so component sharing fights the design. The launch/resume/cancel *logic* moves down;
  their rendering is re-authored.
- **Launch off the dirty buffer** (send the client's in-memory workflow with the run request).
  Rejected: it would need a second write door bypassing `prepareWorkflow`, the write route, and the
  lease, and it would run code that never touched disk — untestable by `git`, the CLI, or the author's
  own editor. Save-first keeps one write door and one save-point.
- **Session-scoped run list** (only the runs this Designer tab launched). Rejected by the driving dev
  in favour of full per-workflow history: an author often wants to compare the current run against the
  last good one from a previous session.

## Consequences

- **The Designer is a peer surface over the same core, not a Viewer clone.** It reuses
  `RunViewModel`/`connectRunViewModel`/`buildRunTree`/`eventOutcome` verbatim and gains four more
  shared units (`parseJsonField`, `eventMessage`, `nodeLabel`/`nodeEventLabel`, the blob-absence
  resolver). A run means the same thing on both surfaces because the meaning lives in one place.
- **`@path/viewer` loses four files' worth of logic to `@path/client-core`** and imports them back. The
  move is behaviour-preserving for the Viewer — same functions, new home — and is the concrete
  discharge of map decision 14's "logic that turns out to be shared moves *into* client-core".
- **The list route gains a `workflow_id` filter.** A small, additive server-API change (a new optional
  query parameter), carried by the assembly ticket, so the Designer's per-workflow history is complete
  rather than a filtered latest-N window.
- **Launch is coupled to the save-point.** The dirty-state/undo model (a separate #254 ticket) now has
  a fixed consumer: launch reads "clean" the same way the lease heartbeat and the `If-Match`
  precondition do. That ticket must define "clean" once for all three.
- **Surface 6's geometry is the prototype's to pin.** This ADR fixes *that* run status projects onto
  canvas nodes and *that* a run inspector holds the tree and per-node I/O; it does not fix the pane
  layout, which the canvas-interaction prototype line (spec § Canvas interaction model) resolves.
- **Resume stays a shared verb with an unshared caveat.** The Designer offers resume; the plan-reuse
  semantics are the engine's existing contract, and the "resume across an edit reuses the old plan"
  caveat is an authoring note in the spec, not new resume behaviour.
