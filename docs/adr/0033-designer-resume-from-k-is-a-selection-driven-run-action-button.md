# Designer Resume-from-K is a selection-driven run-action button, always shown, enabled-or-disabled

Status: accepted

The Designer surface for **Resume-from-chosen-K** ([#430](https://github.com/howardyang2009/PATH/issues/430),
part of map [#427](https://github.com/howardyang2009/PATH/issues/427)) is a third run-action button,
**`Resume from …`**, beside `Resume run` and `Delete run` in the run detail's left action column
(designer-spec.md § Resume from here). K is the **run** of the node the author selects in the middle
run tree; the button is **always rendered** and has exactly two states — enabled, or
disabled-with-one-reason. It is the K-supplied case of the one Resume action (`Resume run` is the
K-omitted auto-boundary case), opening the same config-only form and taking the same engine route
([#429](https://github.com/howardyang2009/PATH/issues/429)).

## Considered Options

### Where the K affordance lives

- **A run-action button keyed to the run-tree selection** (chosen). K must be named by a **run id** —
  the only handle that distinguishes two refs of one nested file or two loop iterations (`CONTEXT.md`
  §Rerun-boundary; ADR 0032). Only a run-tree node carries a run id, so the selection *is* the K pick,
  and one selection already drives the node-I/O inspector (surface 7). A button that reads the current
  selection reuses that gesture and sits with the resume/cancel/delete verbs the author already knows.
- **A per-node context menu on the run tree.** Rejected. The run tree renders dense rows (reuse rows,
  nested child trees, iterations, status glyphs — ADR 0025); a per-row menu or always-visible per-row
  button fights that density, and hides the action behind a right-click the rest of the console never
  uses.
- **An affordance on the canvas node.** Rejected as impossible, not merely worse: a canvas node maps to
  **many** runs and carries no run id, so it cannot name a K.

### What happens when the selected node is not a legal K

- **Keep the button visible, disable it, show the reason** (chosen). The author just clicked a node; a
  button that vanishes reads as a bug ("why did it disappear?"). A disabled button with a one-line
  reason teaches the legal-K rule at the moment of the illegal pick, and reuses the engine's five-reason
  refusal text (ADR 0032). One button, two states, is also less stateful UI than a show/hide toggle
  layered on top of enable/disable.
- **Hide the button on an illegal or absent selection.** Rejected. It is silent — it gives the author
  no way to learn why a given node cannot be a boundary — and it makes the button's presence itself a
  third piece of state to reason about.

### One action or two

- **One action, two triggers** (chosen). `Resume from …` supplies K = the selected run id; `Resume run`
  omits it and resumes from the auto-boundary. Both call the one resume route with K optional (#429),
  so there is no second code path and no second form. This is the surface reading of #427's locked
  "plain Resume is the K = auto-boundary case of one action."
- **A distinct Resume-from-K action with its own form/route.** Rejected: it duplicates the resume form,
  the config gate, and the engine path for a difference that is one optional field on the wire.

## Consequences

- **The button is never hidden; disabled reasons have a fixed precedence.** First that applies wins:
  (1) no node selected — "Select a node in the run tree"; (2) illegal K — the matching entry of the
  five-reason taxonomy (not-succeeded, prefix-not-succeeded, inside loop/parallel/branch, since-deleted,
  unresolvable; ADR 0032); (3) legal K but a dirty buffer — Launch's save-first "Save to enable". This
  keeps "why can't I click" unambiguous, one cause at a time.
- **Legal K is computed client-side, refused server-side.** The client already holds the run tree and
  per-node status, so it enables the button only for a succeeded, top-level, prefix-succeeded row and
  greys the rest eagerly — good latency, no round-trip to learn a node is illegal. The engine's
  `refusal: {status, message}` (ADR 0032) stays the authority for a race where the on-disk file moved
  under the buffer.
- **The clean-buffer gate is shared with Launch; no lease is taken.** Resume-from-K matches K's node
  path against the bytes on disk (#429), so it gates on the same one save-point Launch does (ADR 0030),
  disabling with the save-first affordance while the buffer is dirty. It reads the file only, so it
  takes no edit-lock lease (ADR 0017) — a second tab holding the lease does not block a resume.
- **Nested nodes and reuse rows are selectable K.** The run tree already renders nested workflow-run
  rows and reuse rows with real run ids, and the engine supports nested-K (#433) and reuse-row
  boundaries, so the surface exposes both rather than capping below the engine's contract. A reuse-row
  K re-runs a node the source only reused — legal, and called out in the spec as the one surprise.
- **The label carries identity, the wire carries the run id.** The enabled button reads
  `Resume from <node-name> (<short-run-id>)`; the full run id is the hover title and the
  `rerun_from_run_id` wire value (#429). The name answers *which* node, the short id disambiguates
  duplicate names, and the console stays legible without the author copying a raw GUID.
- **A succeeded run resumes only through this button.** A `succeeded` root run shows no `Resume run`
  (nothing remains from the auto-boundary), so `Resume from …` is its only resume path, enabled once a
  legal K is selected. This is the surface consequence of K-selection being a superset of plain Resume.
