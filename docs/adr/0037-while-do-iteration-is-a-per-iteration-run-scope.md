# A while-do iteration is a per-iteration run scope, so a loop body reuses across Resume

Status: accepted

A `while-do` body's runs are today **direct children of the enclosing workflow-run**: `parentRunId` is
the enclosing run and `nodeId` is the one body id, repeated once per iteration. So a loop that ran N
iterations writes N `succeeded` rows sharing `(scope, node id)`, and the reuse key cannot tell them
apart. [`planReuse`](../../packages/engine/src/plan-reuse.ts) refuses reuse for a node with more than
one succeeded candidate (`succeeded.length === 1`), and `findNestedCounterpart` refuses re-entry on
more than one match. The result ([#454](https://github.com/howardyang2009/PATH/issues/454)): a Resume
whose K sits **after** a loop reuses everything up to the loop, then **re-runs the whole loop body from
scratch** whenever the loop ran more than once — while a one-iteration loop reuses correctly. That
re-burns exactly the LLM tail Resume exists to save ([resume-door-bar.md §4](../research/resume-door-bar.md)
names the money as inside the second iteration's `revise` prompt).

This is the per-iteration-identity gap the retired
[#426](https://github.com/howardyang2009/PATH/issues/426) analyzed and
[ADR 0036 §Consequences](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md) and
[CONTEXT.md §Resume](../../CONTEXT.md) both left out of scope. It is now lifted **for Resume-from-K
reuse** by revising #426's **Option A**: each iteration becomes its own run scope.

## Considered Options

### Per-iteration identity: a run scope, or an ordinal on the leaf rows

- **A per-iteration run scope — one container run per iteration** (chosen, #426 Option A). Each
  iteration mints one run row (`parentRunId` = enclosing run, `nodeId` = the `while-do` node id), and
  the body runs **inside** that scope, so the body's `parentRunId` is the container's run id. `(scope,
  node id)` uniqueness is restored for the body **and everything nested below it** — a nested
  `workflow` step, a nested `parallel` replayed by `wait-one`, a nested `branch` — because their parent
  scope is now the unique container. So `planReuse`, `findNestedCounterpart`, and the wait-one replay
  (`pickReusedWaitOneWinner`) all work **unchanged** inside a container. One scoping rule fixes every
  kind of body at once, uniform with the nested-workflow scoping the engine already has
  (`runWorkflowNode` mints a child run; `executeWorkflowRun` re-enters it on resume).
- **An iteration ordinal on the leaf/body rows — key reuse by `(scope, node id, iteration)`** (#426
  Option B). Rejected. It is lighter for the loop body alone, but the ordinal is a bespoke key every
  reuse reader must learn (`planReuse`, `findNestedCounterpart`, and the wait-one replay), and it does
  **not** fix a nested `parallel` or `branch` inside a loop body — those runs collide on `(scope, node
  id)` across iterations too, and would each need their own ordinal. Option A subsumes them for free.

### The container versus a nested workflow-run: the context boundary

The container reuses the workflow-run's run-identity, emit, and reuse machinery — but it is **not** a
context-isolation boundary, and that is the one way it differs from a nested `workflow` step.

- **A run-tree and reuse scope that shares the loop's context blackboard** (chosen). A `while-do` body
  reads and writes the **enclosing** run's shared context (CONTEXT.md §Composition): the loop condition
  reads `context.verdict`, the body publishes `draft`/`verdict` back into that same context, and the
  cross-iteration default-input chain threads the previous iteration's output into the next
  ([spec §5.4](../spec/mvp-spec.md)). The container therefore threads the loop's context through, and
  does **not** seed a fresh empty context per iteration. On resume a re-entered container reuses the
  body via a `planReuse` **scoped to that container**, and the reused body's `publish` lands in the
  loop's context exactly as a fresh run's would — so iteration N+1's condition sees iteration N's
  reused verdict, and the loop exits at the same point it originally did.
- **A full nested workflow-run per iteration (fresh, isolated context)** (rejected). A nested
  `workflow` step starts with a fresh, empty context and exchanges data only through its `input`/`output`
  objects (CONTEXT.md §Composition, line 223). Applying that to a loop iteration would sever the
  condition and the cross-iteration chain from the body's publishes. The container needs the
  workflow-run's **identity and reuse** scoping without its **context** isolation.

### How a reader tells a container apart: a run kind and an ordinal

`runKind` classifies from `RunRecord` fields alone (`parentRunId`, `reusedFromRunId`, `workerName`).
A container is worker-less, non-root, non-reuse, so it would misclassify as `nested-workflow`.

- **Add an `iteration` run kind, discriminated by a new `iteration: number \| null` field** (chosen).
  The field is non-null **exactly on a container** (its 1-based ordinal) and null on every other row. It
  is both the discriminator `runKind` reads and the ordinal the Viewer renders ("Iteration 2") and the
  resume pairing matches on. One new nullable column, threaded through the one field enumeration
  (`RUN_RECORD_FIELDS`) so the wire codec, the db row, and `blankRunRecord` pick it up from one edit.
- **Reuse the `nested-workflow` kind, no new field** (rejected). It reads in `path runs` and the Viewer
  as a nested workflow named after the `while-do` node, which is not what it is, and it carries no
  ordinal for display or for deterministic resume pairing.

### Resume pairing: by ordinal, or by recorded order

- **Pair replay-iteration N to the counterpart's container with `iteration === N`** (chosen). The loop
  collects the counterpart's containers (`parentRunId` = this run's counterpart, `nodeId` = the
  `while-do` id) and re-enters the one whose ordinal equals the current iteration, through the existing
  `executeWorkflowRun` recursion (counterpart = that container). Deterministic and explicit. Past the
  recorded tail (a fresh iteration the original never ran) no container matches and the iteration runs
  fresh (invariant 4).
- **Pair by recorded `startedAt` order** (rejected). It works only because iterations are sequential;
  the explicit ordinal is the identity, and pairing on it needs no tie-break.

## Consequences

- **The run tree gains a level under every executed `while-do`.** A loop's body runs are no longer
  direct children of the enclosing run; they are children of a per-iteration container, which is a
  child of the enclosing run. `path runs`, the Viewer's run rail, and the read-time cost SUM (`subtree`,
  `findRootRun`) all read the same tree, so they follow the new level without hand-rolled changes — but
  **every existing while-do run-tree test re-baselines** to the container shape, and the code comment at
  `run-workflow.ts` that calls a while-do body's nested run "a first attempt \[that] seeds fresh" is
  removed.
- **`RunRecord` grows one nullable field.** `iteration: number | null`, null on all four existing kinds
  and non-null only on the new fifth. `RunKind` becomes `root | nested-workflow | leaf | reuse |
  iteration`; `runKind` tests the field before the worker-name fall-through. Wire (`wire-v0.ts`), db
  (`fromDbRow`), and `blankRunRecord` follow from `RUN_RECORD_FIELDS`. `@path/client-core`'s
  `view-model` assembles the extra level; the Viewer renders it.
- **Reuse readers are unchanged inside a container.** `planReuse` and `findNestedCounterpart` keep their
  exact `(scope, node id)` keying and their "refuse on more than one" guard; the guard simply never
  fires inside a container, because a container holds at most one run per body node id. The wait-one
  replay works per iteration for the same reason. No reuse reader learns the ordinal.
- **The container shares context; a nested `workflow` step still isolates its own.** The container is a
  scope for run identity and reuse only. A `workflow` step **inside** a loop body keeps its own isolated
  context and its own nested-workflow run, now correctly parented to the iteration container — which is
  what makes the `release-notes` `revise` step (a `workflow` step in a loop) reuse per iteration.
- **A strict superset of today's behavior.** A one-iteration loop gains a single container over its
  existing body run and reuses exactly as before. A zero-iteration loop mints no container (unchanged
  transparent exit). Off-resume, the container is pure audit structure with no reuse effect.
- **K inside a loop body stays out of scope.** This ADR makes a completed loop's body **reuse** when K
  is serialized after the loop. It does **not** make a loop-body node a legal K: CONTEXT.md §Resume's
  refusal of a K "inside a loop/parallel/branch body" is unchanged, and the locus constraint of
  [ADR 0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md) holds. Selecting K inside
  a loop is a later ticket, now unblocked by the per-iteration scope this ADR adds.
- **Acceptance.** Resume-from `write-file` on a two-iteration `release-notes` run reuses both `revise`
  iterations with no fresh `revise` run; the one-iteration case stays correct; a nested `parallel`
  inside a loop body resumes per iteration; `path runs` and the Viewer show each iteration as its own
  scope.
