## Model decided: `person-switch` is a **controller** (not a leaf step)

Outcome of the #545 grilling. Recorded as
[ADR 0047](../blob/main/docs/adr/0047-person-switch-is-a-controller-with-an-authored-activity-and-labelled-slots.md).

**Q1** — Option **A3/B**: `person-switch` is a **worker-less controller** (reserved type name, peer of
`branch`/`while-do`), *not* a plugin folder. A step-type plugin contributes fields + workers; this
construct's content is other nodes.

**Q2** — It reaches **Awaiting** by holding an **authored `person-activity` node** (the `ask` slot) and
dispatching it through the ordinary leaf path. The parked row is that plain leaf run; the controller
itself gains no run, no row, and no status. Complete targets the **leaf's** step-run id, exactly as
today.

**Why not the lighter "engine-minted selection leaf"**: `complete-run.ts` resolves the parked run's
`nodeId` **into the current file** (`resolveNode` matches by `id` alone), then requires
`type === "person-activity"` and reads **that node's** authored `outputSchema` to validate the
submission (ADR 0040). A minted leaf has no file node, so the run would be **un-completable** (409 on
every Complete). The selection activity must therefore be authored.

### The model

| Aspect | Decision |
| --- | --- |
| Kind | Worker-less controller, reserved name `person-switch`, in the core node union |
| Slots | `ask` — single-`node` slot holding exactly one **`person-activity`** node; `children` — a non-empty list of **`{label, node}`** pairs (mirrors `branch`'s `{when, node}` arm) |
| Child kinds | Any node, nested control blocks included |
| Selection value | The selected child's **`label`**, submitted as a plain string |
| Validation | **Load-time**: the `ask` node's `outputSchema` must be a **string enum equal to the `children` labels**; mismatch = registry-relative **invalid file** (discovery reports it, the Designer refuses to open it — ADR 0026's stance). An unknown label at Complete is the ordinary generic `400`, leaf **stays `awaiting`** for retry |
| Reaches Awaiting | `ask` leaf returns `{status:"awaiting"}` → `step.awaiting` → `SeqOutcome awaiting` propagates; every enclosing run stays `running` |
| Completes | Leaf CAS + lease → replay-from-root → `finishSucceeded` on the same step-run id → switch reads the committed label, runs **exactly one** child, returns its output |
| Child input | The **switch's incoming output** (block-slot default rule, format §6.1) |
| Output | The selected child's output, **transparently** (no envelope) |
| Failure | A selected child that fails fails the switch (fail-fast, no re-ask). A selected child that parks propagates `awaiting` |
| Seating | **File body or `sequence` body only.** Refused in a `branch` arm/`else`, a `parallel` branch, and a `while-do` body |

### Invariants: nothing is amended

- **ADR 0038 (Awaiting is leaf-only) holds unchanged.** No controller ever holds `awaiting`; the parked
  row is a plain leaf.
- **Invariant 1 holds unchanged.** A node's run is parented to `ctx.run.identity.runId` — the *enclosing
  workflow-run* (`run-workflow.ts:587`), never a sibling node's run. The `ask` leaf and the selected
  child are both walked as a one-node sequence in the enclosing run's `NodeExecContext`, so their rows
  are **siblings**. The leaf parents nothing; the child is an ordinary child of the enclosing run,
  exactly as a `branch` arm's occupant already is.
- **No new run kind, no new parent scope, no propagation rule.**

### Seating refusals, per container

- **`while-do` body** — the body is re-entered per iteration, so the switch re-asks the same person every
  pass and Complete drives one Complete per iteration; the authored `max_iterations` bound would silently
  become a bound on how often a human is interrupted.
- **`parallel` branch** — a parked switch inherits ADR 0042's outcomes: under `wait-one` it is
  **cancelled** (`sibling-succeeded`) the moment a sibling succeeds, so the person's answer can be
  discarded while they are still deciding; under `collect` the join waits; under `do-not-wait` a
  non-empty publish set is a load error. Admitting it would need a join rule for "a branch member that,
  once resolved, changes which sibling runs".
- **`branch` arm / `else`** — coherent (a taken arm runs the switch at most once), refused for
  legibility: the same activity in two arms means one answer routes within whichever arm happened to be
  taken, which reads file-global but is arm-scoped. Recorded as the reversible alternative.
- **`sequence` is admitted** because a file body is a bare array and any author grouping wraps a
  `sequence`; a controller that could not appear in the only construct that groups nodes would be
  unusable. The rule is intended to be **shared with `goto`** (#546/#550) — BPMN's own same-scope link
  events independently validate the first-level instinct (prior art, #547).

### Unblocked

The frame is fixed for [#552](https://github.com/howardyang2009/PATH/issues/552) (selection act /
surface) and [#553](https://github.com/howardyang2009/PATH/issues/553) (children shape and output
contract). [#555](https://github.com/howardyang2009/PATH/issues/555) (glossary + taxonomy ADR) stays
blocked on [#546](https://github.com/howardyang2009/PATH/issues/546) for `goto`.

No code in this ticket; the output is the ADR plus this decision. Path-only.
