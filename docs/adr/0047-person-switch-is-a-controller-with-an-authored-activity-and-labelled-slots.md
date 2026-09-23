# `person-switch` is a controller holding an authored `person-activity` selection leaf and labelled child slots

**Status:** superseded by [ADR 0052](0052-person-switch-is-a-shipped-step-template-not-a-controller.md)
— `person-switch` is no longer a controller; it is a shipped step-template composing `person-activity`
+ `branch` (origin #477 reframed, map #544). The decision below is kept for the record only.

Originally: accepted; resolved the model decision of Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#545](https://github.com/howardyang2009/PATH/issues/545) ("person-switch: controller or leaf step?"). It
fixes the frame for every later person-switch ticket: the selection act
([#552](https://github.com/howardyang2009/PATH/issues/552)) and the children/output contract
([#553](https://github.com/howardyang2009/PATH/issues/553)). Informed by
[graph-controller-prior-art.md](../research/graph-controller-prior-art.md) (#547). The glossary entry
and the Structure-versus-Graph-Controller taxonomy are
[#555](https://github.com/howardyang2009/PATH/issues/555)'s, and stay blocked until `goto`'s model
([#546](https://github.com/howardyang2009/PATH/issues/546)) lands.

`person-switch` (#477) is a controller a person routes: the run parks, a person picks one of several
child nodes, that node runs, and the block succeeds. It must reach **Awaiting** for the pick. Two
existing rulings appear to forbid that: **Awaiting is a leaf-only run status** (ADR 0038) and **a
controller has no worker, no task, no run** (invariant 1). The decision below satisfies both rather than
breaking either.

## Decision

**`person-switch` is a worker-less controller, a peer of `branch` and `while-do`, that holds an
authored `person-activity` node and a labelled list of selectable child nodes.** The controller
contributes no run of its own and **amends no existing invariant**: it reaches Awaiting by dispatching a
real leaf, so a controller still holds no status, no row, and no worker — the leaf parks as leaves
already do (ADR 0038), and the selected child is an ordinary child of the enclosing workflow-run.

1. **Kind — a reserved controller, not a plugin folder.** The type name `person-switch` joins the
   core node union and `RESERVED_TYPE_NAMES`, beside `parallel`, `branch`, `while-do`, `sequence`, and
   `checkpoint`. It ships no worker, holds no task, and produces no run row of its own (invariant 1).
   It is not a folder under `packages/engine/step-plugins/`, because a step-type plugin contributes
   *fields plus workers*, and this construct contributes neither — its content is other nodes.

2. **Structure — two slots, the `@2` container shape (ADR 0014).**
   - **An `ask` slot** (a single-`node` slot) that holds exactly one **`person-activity`** node. It is
     authored in the file, carries its own durable GUID `id`, and is where the person's instructions
     (`description`), the informational `assignee`, and the `outputSchema` live.
   - **A `children` slot** — a non-empty list of **`{label, node}`** pairs. `label` matches
     `^[a-z][a-z0-9-]*$` and is unique within the switch; `node` is any node, nested control blocks
     included. The pair mirrors `branch`'s established `{when, node}` arm (`nodes.ts`), so the grammar
     shape is not new.

3. **The selection value is a child's `label`, submitted as a plain string** through the existing
   `POST /v0/runs/:step_run_id/complete`. The `ask` node's `outputSchema` is required to be a **string
   enum whose values are exactly the `children` labels**. That agreement is checked at **load**, as
   registry-relative file validity: a switch whose declared choices and declared targets disagree is
   **invalid**, reported by discovery and refused by the Designer's open gate, the same stance an
   unregistered step type takes (ADR 0026). An unknown label at Complete is then the ordinary generic
   refusal — `400`, "output does not match the step's outputSchema" — and the step **stays `awaiting`**
   for a retry (ADR 0040). No switch-specific refusal vocabulary is added.

4. **Input seeds from the switch's incoming output** — the block-slot default-input rule (format §6.1),
   identical to `sequence`/`parallel`/`while-do`. The selected child's input is *not* the selection
   string; it is what the switch itself received.

5. **Output is the selected child's output, transparently.** The switch renames nothing and adds no
   envelope. It is a router, not a joiner: `wait-one`'s `{winner: {name, output}}` exists because a race
   chooses among *concurrent* outputs, and there is no such ambiguity here. Which child ran is already
   in the audit — the parked leaf's row and its `step-awaiting`/`step-finished` events carry the node
   name.

6. **Exactly one child runs, exactly once.** After the selection, `runPersonSwitchNode` runs the chosen
   child as a one-node sequence and returns its outcome. There is no re-selection and no fallback: a
   selected child that **fails** fails the switch (ordinary fail-fast), and a selected child that itself
   **parks** propagates `awaiting` — the existing rule, with no new case. The seating rule below
   guarantees the switch itself is visited once per run, so it never asks the same person twice.

## Why the `person-activity` node must be authored, not engine-minted

The tempting lighter design — the engine mints a synthetic selection leaf so the author declares only
`description` and the children — is **not implementable**, and the reason is a hard precondition on the
Complete door. `complete-run.ts` resolves the parked run's `nodeId` **into the current workflow file**
(`resolveNode`, which matches by `id` alone), then requires that node's `type` to be `person-activity`
and reads **that node's** authored `outputSchema` to validate the submission (ADR 0040). An
engine-minted leaf has no file node, so `resolveNode` returns `undefined`, the route refuses `409`, and
the parked run can never be completed. The same precondition governs the client: `findAwaitingNode`
reads the `description`/`assignee`/`outputSchema` for the chooser surface off the file node by id.

So the selection activity is authored, and the `ask` slot is the one place it may live. This is also why
the alternative of *embedding children in a plugin folder's `fields`* fails: a leaf step's worker
receives only `{fields, input, config, cwd, signal}` and can never see or run child nodes, and a leaf
that parents runs is a run kind PATH does not have.

## Seating: where a `person-switch` may sit

**A `person-switch` may sit in the file body or in a `sequence` body, and nowhere else.** It is refused
inside a `branch` arm or `else`, a `parallel` branch, and a `while-do` body. One rule, intended to be
shared with `goto` (#546/#550), whose "first-level jump" constraint the prior art independently
validates: BPMN's own same-scope link events cannot cross a subprocess boundary (graph-controller-prior-art.md
§4, citing Camunda). `sequence` is admitted because a file body is a bare array and any author grouping
wraps a `sequence`; a controller that could not appear in the only construct that groups nodes would be
unusable.

The three refusals are for three different reasons, and the asymmetry is deliberate — the
`person-activity` *leaf* remains legal inside a `branch` arm and a `parallel` branch (ADR 0042):

- **`while-do` body.** The body is re-entered per iteration, so the switch re-asks the same person every
  pass, and Complete's replay-from-root drives one Complete per iteration — a controller whose content
  is a person's decision multiplied by an unbounded loop turns the authored `max_iterations` bound into
  a bound on how many times a human will be interrupted.
- **`parallel` branch.** ADR 0042 already states the outcomes a parked leaf suffers inside a join: under
  `collect` the join waits; under `wait-one` the parked branch is **cancelled** (`sibling-succeeded`) the
  moment a sibling succeeds, so the person's answer can be discarded while they are still deciding; under
  `do-not-wait` it is legal only with an empty publish set, and a switch's publish set includes its
  children's. A switch *is* routing, so admitting it here would need a join rule for "a branch member
  that, once resolved, changes which sibling runs" — semantics no ADR writes.
- **`branch` arm / `else`.** The weakest of the three and coherent on its own: a taken arm runs the
  switch at most once, so nothing mechanical breaks. It is refused because the person's question becomes
  ambiguous — the same activity in two arms means one answer routes within whichever arm happened to be
  taken, which reads file-global but is arm-scoped, and only the leaf's parent node name in the audit
  tells them apart. Refusing the nesting costs a readable-but-unwanted structure; admitting it costs a
  legibility trap.

## No invariant is amended

Both apparent conflicts dissolve, which is the design's whole point, so this ADR **amends nothing**.

**Invariant 1 and ADR 0014 stand untouched, because the selection leaf parents no run.** A node's run is
parented to `ctx.run.identity.runId` — the *enclosing workflow-run* (`run-workflow.ts:587`; the same at
`runLoopIteration:1368`) — never to a sibling node's run. The switch's `ask` leaf and the child it
selects are both walked by `runPersonSwitchNode` as a one-node sequence **in the enclosing run's
`NodeExecContext`**, so the two rows are **siblings** under that run, keyed by their own distinct node
ids. The selection leaf is therefore an ordinary leaf run that parents nothing, and the selected child
is an ordinary child of the enclosing run — exactly what a `branch` arm's occupant or a `sequence`
element already is. No controller gains a run, a row, or a new kind.

**ADR 0038 needs no amendment either.** No controller ever holds the `awaiting` status: the parked row is
an ordinary `person-activity` **leaf** run, its `status = awaiting`, and every enclosing run — the
switch's enclosing workflow-run included — stays `running`. The switch's own `SeqOutcome` is `awaiting`,
which is the existing propagation rule any node's outcome already follows
(`run-context.ts`, `executeWorkflowRun`). Awaiting stays leaf-only; a controller gains no run kind, no
row shape, and no propagation rule.

The one thing that *is* new is not an invariant but a fact worth stating, because a reader will look for
it: `person-switch` reaches Awaiting by **dispatching a real leaf**, so it inherits the whole parked-run
contract (ADR 0039 durability, ADR 0040 validation, ADR 0041 appendable-tree replay) by construction,
rather than by restating it for a controller.

## Considered options

- **A leaf step-type plugin (`person-switch` as a folder), whose worker returns `{status: "awaiting"}`
  and whose "Complete output is the selected node id".** Rejected. A leaf worker's request is
  `{fields, input, config, cwd, signal}` — it cannot enumerate or run child nodes, so the children must
  be embedded in `fields` as data the *engine* then reads back, which makes the plugin's typed fragment
  a second, unvalidated grammar beside the node union. And a leaf that parents runs is a run kind PATH
  does not have, so it must either mint a synthetic scope or break the five-kind classification.
- **An engine-minted selection leaf, with the switch declaring `description`/`outputSchema` itself.**
  Rejected — not merely disfavoured. The Complete door resolves the parked leaf by `nodeId` in the
  current file and reads that node's `outputSchema`; a minted node is not in the file, so the run is
  un-completable. Stated in full above.
- **An awaiting-bearing controller with its own run kind** (extend Awaiting to a controller, cf.
  `while-do`'s per-iteration container). Rejected. It buys nothing the authored leaf does not already
  give, and it pays for it by breaking ADR 0038 head-on, adding a persisted run kind (a nullable field
  threaded through `RUN_RECORD_FIELDS`, the wire codec, the db row, `run-kind.ts`, and the reuse
  keying), and inventing a parent-side status transition that ADR 0038 rejected as "a recursive cascade
  up the ancestor chain on every leaf park".
- **The sibling-target reading** — the switch declares targets among the nodes *after* it and the walk
  jumps there, the switch having no output of its own. Rejected for this ticket: that is `goto` with a
  person on the trigger, and it belongs to the `goto` model decision (#546). The containment reading is
  the one #477 describes ("the selected node will go to running … then this person-switch controller
  will succeed") and the one that reuses `CONTROL_CHILD_SLOTS` verbatim without introducing an edge.
- **A `{selected, output}` envelope as the block's output.** Rejected: duplicates the audit record for
  no consumer, and adds a shape where the block-slot rule already defines one.
- **Refusing `sequence` too ("file body only").** Rejected: any author grouping of nodes, including the
  natural `[switch, tail]` arrangement, is a `sequence`, so the rule would make the controller nearly
  unplaceable.
- **Admitting `branch` arms** (the "anywhere that runs at most once per run" phrasing). Recorded as the
  live alternative; refused for the legibility reason above and reversible in a later ADR if a real
  workflow wants it, since the change is additive to one slot table.

## Consequences

- **The core node union grows by one member.** `person-switch` joins `WorkflowNode`, the core zod
  members, `RESERVED_TYPE_NAMES`, `CONTROLLER_TYPES`/`isStepType`, and `CONTROL_CHILD_SLOTS` (the two
  slots), each of which is `never`/`satisfies`-guarded so omitting it is a compile error. `runNode`'s
  controller branch gains `runPersonSwitchNode`, which reaches Awaiting by running `ask` through the
  ordinary leaf path and routes by reading the ask node's committed output.
- **`complete-run.ts`'s `AWAITING_STEP_TYPE` gate needs no change.** It is today the single hard-coded
  `"person-activity"` check (duplicated in `@path/client-core`'s `awaiting-node.ts`), and the parked row
  is still a `person-activity` leaf — so validation, `outputSchema` lookup, and the leaf CAS all keep
  working verbatim. What the surfaces need (deferred to #552) is a *read*, not a gate change: whether
  the leaf's enclosing node is a `person-switch`, so the chooser copy can say which block is asking. No
  second awaiting type is introduced.
- **A new load-time refinement** enters the schema layer: the `ask` node of a `person-switch` must be a
  `person-activity` node, and its `outputSchema` must be a string enum equal to the `children` labels.
  Both are reported through the existing invalid-file channel (discovery, Designer open gate).
- **Publish-set reasoning is unchanged.** A `person-switch`'s publish set is the union of its children's,
  exactly as a `branch` block unions its arms'; unchosen children never run, and because the chosen
  child runs alone there is no concurrent-disjoint obligation to weaken. The existing check
  (`publish-set.ts`) needs no switch-specific case.
- **Resume and reuse inherit the standard rules.** A switch that reached `succeeded` is reused as any
  node is; one parked at its ask leaf is non-succeeded, so Resume re-runs it and it parks afresh
  (ADR 0042's cause-blind rule). The parked leaf is completed by the appendable-tree replay as any
  `person-activity` leaf is.
- **This ticket writes no code.** The output is this ADR plus the decision comment on #545; #552 and
  #553 carry the specs, and #555 the glossary and the Structure/Graph Controller taxonomy. The `goto`
  model (#546) remains the other half of that taxonomy.
- **Acceptance.** `person-switch` with `ask` + three labelled children loads and is valid; a switch whose
  `outputSchema` enum disagrees with its `children` labels is reported invalid by discovery; a run parks
  with the leaf row `awaiting` and the root `running`; Complete with a known label runs exactly one child
  and succeeds the block; Complete with an unknown label is `400` and the leaf stays `awaiting`; a
  `person-switch` inside a `while-do` body is a load error; the selected child's output is the block's
  output with no envelope.
