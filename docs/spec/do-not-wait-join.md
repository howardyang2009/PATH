# `do-not-wait` join — feature spec

**Status:** Design signed off (grilling session, 2026-08-10). A decision opened this door, not a fired
trigger. The `do-not-wait` row in the [v-next register (#109)](https://github.com/howardyang2009/PATH/issues/109)
names the trigger "a workflow that wants a branch to run past the block without being waited on." No
such workflow exists yet. The maintainer chose to design ahead of that evidence, exactly as `wait-one`
did ([wait-one-join.md](wait-one-join.md) §1). Thus there is **no motivating workflow and no
non-synthetic acceptance case**. The acceptance workflow (§9) exercises the mechanism; it does not
relieve a real pain.

This spec is normative for the `do-not-wait` join mode. It extends `mvp-spec.md` §5.2, §5.4, §5.6, and
§5.7, and `workflow-format-v0.md` §10. Those sections point here.

## 1. Summary

A `parallel` block's `join` gains a third value: `do-not-wait`. `collect` waits for **every** branch
and lands them all. `wait-one` **races** the branches and keeps the first to succeed. `do-not-wait`
**launches every branch and does not wait for any of them at the join**. The block completes the
instant it launches its branches. The next node runs while the branches continue. Use it to kick work
off and move on. It is fire-and-forget side-effect work whose result the main path never reads.

```
parallel, join: do-not-wait
  branch notify:   step (post to Slack)
  branch telemetry: step (emit to a slow sink)
next step: runs immediately, does not see either branch
```

### 1.1 What "detached" means here — a **narrow** redraw of §5.2

`mvp-spec.md` §5.2 states "structured concurrency; no detached runs." `do-not-wait` redraws that line,
but **only as far as it must**. A `do-not-wait` branch is detached from its **`parallel` block**: the
block does not wait for it. But it is **not** detached from the run tree. The engine awaits it at the
boundary of the **workflow-run that owns the block** (§2). Thus the run tree stays **strictly nested**:
every workflow-run still fully contains all of its descendant runs before it returns. No run ever
outlives the process. `path run` never returns while a descendant is still live. "Detached" is scoped
to the block, not to the root run.

This is the whole reason the cancel, resume, and cost model below is a small delta, not a rewrite. The
invariant those systems key against ("a workflow-run contains its descendants") is preserved.

## 2. Join semantics

- **Launch-and-continue.** At the join, the block launches all branches and **completes at once**. The
  block's successor node starts immediately. The join consults no branch's status. The branches run
  concurrently with the main path, under the same fan-out cap as any parallel branches
  (`mvp-spec.md` §5.5).
- **Enclosing-workflow-run barrier.** The workflow-run that owns the `do-not-wait` block does **not
  return** until every one of its detached branches reaches a terminal status (`succeeded`, `failed`,
  or `cancelled`). The barrier sits at the end of that run, not at the block. For a top-level workflow,
  the enclosing run **is** the root run, so this is a root-exit barrier. For a nested workflow-step, it
  is that inner run's exit. Strict nesting (§1.1) is exactly this barrier.
- **No cross-cancellation.** A `do-not-wait` branch that fails cancels **nothing**. It does not cancel
  its siblings (they are independent fire-and-forget work). It does not cancel the main path (which has
  already moved on). This matches `wait-one`'s "failure does not cross-cancel." It contrasts with
  `collect`, where a failing branch cancels its in-flight siblings (`sibling-failed`).

## 3. Output object

The block's output is the **empty object**:

```json
{}
```

Every branch is detached. The block waits on none. None may publish (§4). Thus the block has nothing to
hand downstream. `{}` satisfies the one-output-object rule (`mvp-spec.md` §5.4) trivially. A downstream
`input ←` ref into the block's output resolves against an empty object and finds nothing. This is
correct: a `do-not-wait` block produces no readable result. §11 considered and rejected a launch
**manifest** (a list of fired branch names) as a feature that no use case asked for.

## 4. Context and publishes

A `do-not-wait` branch **may not `publish`.** `workflow-file.ts` **statically rejects** any `publish`
inside a `do-not-wait` branch at load. This is a load error, not a silent drop.

The reason is the context write-timing rule (`mvp-spec.md` §5.3): a `publish` lands atomically on step
success **before the next node starts**. A `do-not-wait` branch finishes **after** the join. That is,
it finishes after the block's successor, and possibly after many later nodes, have already run against
context. A publish from such a branch would be a write **after** its readers, into the shared
per-workflow-run context blackboard (`mvp-spec.md` §5.3). That is a nondeterministic write-after-read
with no honest landing time. A fire-and-forget branch is by definition never read. Thus to forbid
`publish` costs the author nothing and removes the hazard entirely.

- `collect` — branch publishes land at the join (unchanged).
- `wait-one` — the winner's publishes land at the join (unchanged).
- `do-not-wait` — a `publish` inside a branch is a **load error**.

This makes `do-not-wait` the one join under which a branch is a pure side-effect actor. It can run a
`binary` or `prompt` step for its external effect. But it contributes nothing to context.

## 5. Failure isolation

A `do-not-wait` branch that **fails does not fail its tree.** The engine records its failure on its own
run row and narrates it with its own `step-finished` log event. There it stops. The enclosing
workflow-run reaches its barrier (§2), observes the branch terminal (here `failed`), and returns on the
strength of its **main path** alone. Thus a workflow-run can end `succeeded` with a `failed`
`do-not-wait` branch in its subtree.

This **breaks the standing invariant** that a failed descendant run fails its ancestor (`mvp-spec.md`
§5.6 fail-fast; a failing `collect` branch fails its block). The break is deliberate and confined to
`do-not-wait`. You detached the branch precisely because its outcome does not gate the pipeline. Thus
to propagate its failure would contradict the join you chose. The break is surprising (the sibling
joins propagate), hard to reverse (downstream status logic and `path runs list` filters would come to
depend on it), and a real trade-off. So it is captured as
[**ADR 0008**](../adr/0008-do-not-wait-detached-failure-does-not-fail-tree.md).

The branch's status is still fully **auditable**: `failed` on its run row, filterable in `path runs
list`. Isolation means the failure does not *propagate*, not that it is hidden.

## 6. Cancellation

`do-not-wait` introduces **no new `run-cancelled` cause.** `collect` added `sibling-failed` and
`wait-one` added `sibling-succeeded` because each has a sibling-driven cancel path. `do-not-wait` has
none (§2: no cross-cancellation, and the barrier *waits* rather than cancels). The only way to cancel a
detached branch is the existing one: an **operator** cancels the root run (`mvp-spec.md` §5.6, external
abort). The abort reaches every descendant, detached branches included, under cause `operator`. The
causes remain **`operator` | `sibling-failed` | `sibling-succeeded`**.

## 7. Resume interaction

Resume is **cause-blind and unchanged** for `do-not-wait`. There is **no short-circuit**. This is a
deliberate divergence from `wait-one`, explained below.

Resume re-runs every node that is not `succeeded`. It reuses every node that is
([ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md), `mvp-spec.md` §5.6). Apply this to a
`do-not-wait` block whose branches stopped non-`succeeded` in the predecessor (failed, cancelled, or
still-live when the tree was frozen). The branches **re-run** on the successor, exactly like any other
non-`succeeded` node. The block re-launches them, and the enclosing-run barrier awaits them again.

- **At-least-once, so detached side effects can double-fire on resume.** A `do-not-wait` branch can
  post to Slack, then be interrupted before it reaches `succeeded`. It will post **again** on resume.
  This is the general at-least-once resume contract (`mvp-spec.md` §5.6), applied without exception.
  **Idempotency is the author's burden.** It is the same burden every step already carries, no weaker
  and no stronger for a detached branch.
- **Why no short-circuit, unlike `wait-one`?** `wait-one`'s losers are short-circuited on resume
  ([ADR 0004](../adr/0004-wait-one-resume-short-circuit.md)). They are the losers of a race **already
  decided** by a reused winner. To re-run them is not "finish unfinished work"; it re-litigates a
  settled contest, and the join has no need of them. A `do-not-wait` branch is the opposite. It is
  **independent** work in no race, decided by nothing. To a cause-blind resume, a branch left
  non-`succeeded` is ordinary unfinished work. So to re-run it *is* the resume contract doing its job,
  not a waste to suppress. To suppress it would need a `do-not-wait`-specific exception to the
  cause-blind rule, for no benefit the author cannot get by writing an idempotent step.

The consequence: `do-not-wait` adds **nothing** to the resume contract. It merely obeys it. `wait-one`
needed ADR 0004 precisely because it *departs* from the cause-blind default. The divergence is
deliberate. A reader should not try to "fix" it into a mirror of ADR 0004. This is itself recorded as
[**ADR 0009**](../adr/0009-do-not-wait-resume-re-fires-no-short-circuit.md).

## 8. Cost accounting

`do-not-wait` branch runs are **ordinary tree members for cost.** The §5.7 cost roll-up sums usage
across the tree status-blind. Thus a detached branch's `usage` and `estimated_cost_usd` count toward
the root figure **regardless of the branch's status**. A `failed` detached branch still burned the
tokens it burned. The roll-up records real spend, not successful spend. The enclosing-run barrier (§2)
guarantees every detached branch is terminal before its owning run exits. So all detached spend is
**final at roll-up time**. There is no async cost that lands after the number is computed.

## 9. Edge cases

- **Single-branch `do-not-wait`** — legal (`branches.min(1)` unchanged). It is a one-branch
  fire-and-forget. There is no special case.
- **`join-applied` event** — fires at the join, when the block discharges and the main path proceeds.
  It carries **no `winner`** (that field is `wait-one`-only) and no branch outputs, because there is
  nothing landed to name. It marks only that the block resolved and the successor began. Each detached
  branch still emits its own `step-started` and `step-finished` later, on its own timeline.
- **All branches fail** — unlike `wait-one` (all-fail fails the block), `do-not-wait` **does not
  fail**. Every branch failure is isolated (§5). So even all-fail leaves the block discharged and the
  main path untouched. The engine records the failures per-branch, and there they stop.

## 10. Build order

This is not part of this map's destination. (The destination is this signed-off spec; `path` builds it
as separate tickets, the `wait-one` #194–197 pattern.) It is recorded here as the anticipated shape.

Order the commits by dependency. Keep them small. Repo rule: `main` is protected, PR-only, and CI
`test` must be green.

1. **Schema** (`packages/schema`)
   - `nodes.ts:73` — widen `join: z.enum(["collect","wait-one"])` to
     `z.enum(["collect","wait-one","do-not-wait"])`.
   - `workflow-file.ts` — reject any `publish` inside a `do-not-wait` branch at load (§4). It sits
     beside the existing `findDuplicatePublishKeys` join-aware logic (`workflow-file.ts:73-98`), which
     stays as is. This is a new, separate check.
   - Tests: accept `do-not-wait`; a `publish` under a `do-not-wait` branch rejects; single branch is
     ok.
2. **Engine launch-and-continue** (`packages/engine/run-workflow.ts`, parallel executor)
   - `do-not-wait` path: launch all branches, complete the block immediately with output `{}`, start
     the successor. Hold the branch handles on the enclosing workflow-run. Await them at that run's
     exit barrier (§2). A branch failure neither cancels siblings nor fails the run (§5). Add no new
     cancel cause (§6).
   - Emit `join-applied` (no `winner`) at the join (§9).
3. **Resume** — **no engine change** beyond schema acceptance. The cause-blind path already re-runs
   non-`succeeded` branches correctly (§7). Add a resume test that asserts a non-`succeeded` detached
   branch re-runs (the intended at-least-once behavior), to lock the *absence* of a short-circuit.
4. **Docs** — `mvp-spec.md` §5.2 (redraw the "no detached runs" line per §1.1), §5.4 (add the
   `do-not-wait` output row), §5.6 (failure isolation and no new cause), §5.7 (cost note);
   `workflow-format-v0.md` §10; ADR 0008. CONTEXT.md already lists `do-not-wait` as a deferred join
   mode. Update it to shipped when this lands.
5. **Acceptance** — one **synthetic** `do-not-wait` workflow (§1: no real driver). A block fires a
   side-effect branch and moves on. It exercises launch-and-continue, the enclosing-run barrier,
   `publish` rejection at load, failure isolation, and resume re-fire. Mark it synthetic in the
   acceptance NOTES, like the deliberately-absent items already are.

## 11. Out of scope

- **Per-branch / mixed detach** — to flag *some* branches of a block detached while others are waited.
  `do-not-wait` is a **whole-block** join mode (every branch detaches), symmetric with `collect` and
  `wait-one`. A per-branch detach axis is a larger surface with its own output, publish, and failure
  rules. It gets its own door if a real workflow ever wants it.
- **Outlive-the-root (true detach)** — a branch that survives past `path run` returning, whether
  engine-tracked or fully fire-and-forget (Unix `&`). This spec deliberately keeps the tree strictly
  nested (§1.1). True detach shatters the cancel, resume, and cost model wholesale. It is a separate,
  larger redraw.
- **Launch manifest output** — a block output that lists the fired branch names (§3). There is no use
  case. `{}` is the minimal honest value.
- **A `do-not-wait` resume short-circuit** — deliberately *not* built (§7). To re-run a non-`succeeded`
  detached branch is the correct at-least-once behavior, not a waste to suppress.

## References

- Register: [#109](https://github.com/howardyang2009/PATH/issues/109)
- Sibling spec: [wait-one-join.md](wait-one-join.md)
- `mvp-spec.md` §5.2–5.7
- `workflow-format-v0.md` §10
- CONTEXT.md — *Logicer*, *Join mode*, *Cancellation*, *Cost*
- [ADR 0001 — resumed run is a successor run](../adr/0001-resumed-run-is-a-successor-run.md)
- [ADR 0004 — `wait-one` resume short-circuit](../adr/0004-wait-one-resume-short-circuit.md) (the contrast, §7)
- [ADR 0008 — a `do-not-wait` detached failure does not fail its tree](../adr/0008-do-not-wait-detached-failure-does-not-fail-tree.md)
- [ADR 0009 — `do-not-wait` resume re-fires; no short-circuit](../adr/0009-do-not-wait-resume-re-fires-no-short-circuit.md)
