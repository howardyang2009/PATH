# `do-not-wait` join — feature spec

**Status:** Design signed off (grilling session, 2026-08-10). This door was opened **by decision, not by a
fired trigger** — the `do-not-wait` row in the [v-next register (#109)](https://github.com/howardyang2009/PATH/issues/109)
names the trigger "a workflow that wants a branch to run past the block without being waited on," and no
such workflow exists yet. The maintainer chose to design ahead of that evidence, exactly as `wait-one`
was ([wait-one-join.md](wait-one-join.md) §1). There is therefore **no motivating workflow and no
non-synthetic acceptance case**; the acceptance workflow (§9) is written to exercise the mechanism, not
to relieve a real pain.

This spec is normative for the `do-not-wait` join mode. It extends `mvp-spec.md` §5.2, §5.4, §5.6, §5.7
and `workflow-format-v0.md` §10; those sections are updated to point here.

## 1. Summary

A `parallel` block's `join` gains a third value, `do-not-wait`. Where `collect` waits for **every**
branch and lands them all, and `wait-one` **races** the branches and keeps the first to succeed,
`do-not-wait` **launches every branch and does not wait for any of them at the join**. The block
completes the instant its branches are launched; the next node runs while the branches keep going. It is
the join for "kick these off and move on" — fire-and-forget side-effect work whose result the main path
never reads.

```
parallel, join: do-not-wait
  branch notify:   step (post to Slack)
  branch telemetry: step (emit to a slow sink)
next step: runs immediately, does not see either branch
```

### 1.1 What "detached" means here — a **narrow** redraw of §5.2

`mvp-spec.md` §5.2 states "structured concurrency; no detached runs." `do-not-wait` redraws that line,
but **only as far as it must**. A `do-not-wait` branch is detached from its **`parallel` block** — the
block does not wait for it — but it is **not** detached from the run tree. It is awaited at the boundary
of the **workflow-run that owns the block** (§2). The run tree therefore stays **strictly nested**: every
workflow-run still fully contains all of its descendant runs before it returns. No run ever outlives the
process, and `path run` never returns while a descendant is still live. "Detached" is scoped to the
block, not to the root run.

This is the whole reason the cancel / resume / cost model below is a small delta rather than a rewrite:
the invariant those systems key against ("a workflow-run contains its descendants") is preserved.

## 2. Join semantics

- **Launch-and-continue.** At the join, the block launches all branches and **immediately completes**;
  the block's successor node starts at once. No branch's status is consulted at the join. The branches
  run concurrently with the main path, subject to the same fan-out cap as any parallel branches
  (`mvp-spec.md` §5.5).
- **Enclosing-workflow-run barrier.** The workflow-run that owns the `do-not-wait` block does **not
  return** until every one of its detached branches has reached a terminal status (`succeeded`,
  `failed`, or `cancelled`). The barrier sits at the end of that run, not at the block. For a top-level
  workflow the enclosing run **is** the root run, so this is a root-exit barrier; for a nested
  workflow-step it is that inner run's exit. Strict nesting (§1.1) is exactly this barrier.
- **No cross-cancellation.** A `do-not-wait` branch that fails cancels **nothing** — not its siblings
  (they are independent fire-and-forget work) and not the main path (which has already moved on). This
  matches `wait-one`'s "failure does not cross-cancel" and contrasts with `collect`, where a failing
  branch cancels its in-flight siblings (`sibling-failed`).

## 3. Output object

The block's output is the **empty object**:

```json
{}
```

Every branch is detached, none is waited on, and none may publish (§4), so there is nothing for the
block to hand downstream. `{}` satisfies the one-output-object rule (`mvp-spec.md` §5.4) trivially. A
downstream `input ←` ref into the block's output resolves against an empty object and finds nothing —
which is correct: a `do-not-wait` block produces no readable result. A launch **manifest** (a list of
fired branch names) was considered and rejected in §11 as a feature no use case asked for.

## 4. Context and publishes

A `do-not-wait` branch **may not `publish`.** `workflow-file.ts` **statically rejects** any `publish`
inside a `do-not-wait` branch at load — a load error, not a silent drop.

The reason is the context write-timing rule (`mvp-spec.md` §5.3): a `publish` lands atomically on step
success **before the next node starts**. A `do-not-wait` branch finishes **after** the join, i.e. after
the block's successor — and possibly many later nodes — have already run against context. A publish from
such a branch would be a write **after** its readers, into the shared per-workflow-run context blackboard
(`mvp-spec.md` §5.3): a nondeterministic write-after-read with no honest landing time. Since a
fire-and-forget branch is by definition never read, forbidding `publish` costs the author nothing and
removes the hazard entirely.

- `collect` — branch publishes land at the join (unchanged).
- `wait-one` — winner's publishes land at the join (unchanged).
- `do-not-wait` — `publish` inside a branch is a **load error**.

This makes `do-not-wait` the one join under which a branch is a pure side-effect actor: it may run a
`binary` or `prompt` step for its external effect, but it contributes nothing to context.

## 5. Failure isolation

A `do-not-wait` branch that **fails does not fail its tree.** Its failure is recorded on its own run row
and narrated by its own `step-finished` log event, and there it stops. The enclosing workflow-run reaches
its barrier (§2), observes the branch terminal (here `failed`), and returns on the strength of its **main
path** alone. A workflow-run can therefore end `succeeded` with a `failed` `do-not-wait` branch in its
subtree.

This **breaks the standing invariant** that a failed descendant run fails its ancestor (`mvp-spec.md`
§5.6 fail-fast; a failing `collect` branch fails its block). The break is deliberate and confined to
`do-not-wait`: you detached the branch precisely because its outcome does not gate the pipeline, so
propagating its failure would contradict the join you chose. Because it is surprising (the sibling joins
propagate), hard to reverse (downstream status logic and `path runs list` filters would come to depend on
it), and a real trade-off, it is captured as
[**ADR 0008**](../adr/0008-do-not-wait-detached-failure-does-not-fail-tree.md).

The branch's status is still fully **auditable** — `failed` on its run row, filterable in `path runs
list`. Isolation means the failure does not *propagate*, not that it is hidden.

## 6. Cancellation

`do-not-wait` introduces **no new `run-cancelled` cause.** `collect` added `sibling-failed` and
`wait-one` added `sibling-succeeded` because each has a sibling-driven cancel path; `do-not-wait` has
none (§2: no cross-cancellation, and the barrier *waits* rather than cancels). The only way a detached
branch is cancelled is the existing one: an **operator** cancels the root run (`mvp-spec.md` §5.6,
external abort), and the abort reaches every descendant, detached branches included, under cause
`operator`. The causes remain **`operator` | `sibling-failed` | `sibling-succeeded`**.

## 7. Resume interaction

Resume is **cause-blind and unchanged** for `do-not-wait`. There is **no short-circuit** — this is a
deliberate divergence from `wait-one`, explained below.

Resume re-runs every node that is not `succeeded` and reuses every one that is
([ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md), `mvp-spec.md` §5.6). Applied to a
`do-not-wait` block whose branches stopped non-`succeeded` in the predecessor (failed, cancelled, or
still-live when the tree was frozen), the branches **re-run** on the successor, exactly like any other
non-`succeeded` node. The block re-launches them and the enclosing-run barrier awaits them again.

- **At-least-once, so detached side effects can double-fire on resume.** A `do-not-wait` branch that
  posted to Slack, then was interrupted before reaching `succeeded`, will post **again** on resume. This
  is the general at-least-once resume contract (`mvp-spec.md` §5.6), applied without exception.
  **Idempotency is the author's burden** — the same burden every step already carries, no weaker and no
  stronger for a detached branch.
- **Why no short-circuit, unlike `wait-one`?** `wait-one`'s losers are short-circuited on resume
  ([ADR 0004](../adr/0004-wait-one-resume-short-circuit.md)) because they are the losers of a race
  **already decided** by a reused winner: re-running them is not "finish unfinished work," it re-litigates
  a settled contest, and the join has no need of them. A `do-not-wait` branch is the opposite: it is
  **independent** work in no race, decided by nothing. A branch left non-`succeeded` is, to a cause-blind
  resume, ordinary unfinished work — so re-running it *is* the resume contract doing its job, not a
  waste to be suppressed. Suppressing it would require inventing a `do-not-wait`-specific exception to the
  cause-blind rule for no benefit the author cannot get by writing an idempotent step.

The consequence: `do-not-wait` adds **nothing** to the resume contract — it merely obeys it, where
`wait-one` needed ADR 0004 precisely because it *departs* from the cause-blind default. That the
divergence is deliberate (and not an oversight a reader should try to "fix" into a mirror of ADR 0004) is
itself recorded as [**ADR 0009**](../adr/0009-do-not-wait-resume-re-fires-no-short-circuit.md).

## 8. Cost accounting

`do-not-wait` branch runs are **ordinary tree members for cost.** The §5.7 cost roll-up sums usage across
the tree status-blind, so a detached branch's `usage` and `estimated_cost_usd` count toward the root
figure **regardless of the branch's status** — a `failed` detached branch still burned the tokens it
burned, and the roll-up records real spend, not successful spend. The enclosing-run barrier (§2)
guarantees every detached branch is terminal before its owning run exits, so all detached spend is
**final at roll-up time**; there is no async cost that lands after the number is computed.

## 9. Edge cases

- **Single-branch `do-not-wait`** — legal (`branches.min(1)` unchanged). A one-branch fire-and-forget;
  no special case.
- **`join-applied` event** — fires at the join, when the block discharges and the main path proceeds. It
  carries **no `winner`** (that field is `wait-one`-only) and no branch outputs — there is nothing landed
  to name. It marks only that the block resolved and the successor began. Each detached branch still emits
  its own `step-started` / `step-finished` later, on its own timeline.
- **All branches fail** — unlike `wait-one` (all-fail fails the block), `do-not-wait` **does not fail**:
  every branch failure is isolated (§5), so even all-fail leaves the block discharged and the main path
  untouched. The failures are recorded per-branch and there stop.

## 10. Build order

Not part of this map's destination (the destination is this signed-off spec; `path` builds it as separate
tickets, the `wait-one` #194–197 pattern). Recorded here as the anticipated shape.

Dependency-ordered, small commits. Repo rule: `main` protected, PR-only, CI `test` green.

1. **Schema** (`packages/schema`)
   - `nodes.ts:73` — widen `join: z.enum(["collect","wait-one"])` → `z.enum(["collect","wait-one","do-not-wait"])`.
   - `workflow-file.ts` — reject any `publish` inside a `do-not-wait` branch at load (§4). Sits beside
     the existing `findDuplicatePublishKeys` join-aware logic (`workflow-file.ts:73-98`), which stays as
     is; this is a new, separate check.
   - Tests: accept `do-not-wait`; a `publish` under a `do-not-wait` branch rejects; single branch ok.
2. **Engine launch-and-continue** (`packages/engine/run-workflow.ts`, parallel executor)
   - `do-not-wait` path: launch all branches, complete the block immediately with output `{}`, start the
     successor; hold the branch handles on the enclosing workflow-run; await them at that run's exit
     barrier (§2); a branch failure neither cancels siblings nor fails the run (§5); no new cancel cause
     (§6).
   - Emit `join-applied` (no `winner`) at the join (§9).
3. **Resume** — **no engine change** beyond schema acceptance: the cause-blind path already re-runs
   non-`succeeded` branches correctly (§7). Add a resume test asserting a non-`succeeded` detached branch
   re-runs (the intended at-least-once behavior), to lock the *absence* of a short-circuit.
4. **Docs** — `mvp-spec.md` §5.2 (redraw the "no detached runs" line per §1.1), §5.4 (add the
   `do-not-wait` output row), §5.6 (failure isolation + no new cause), §5.7 (cost note);
   `workflow-format-v0.md` §10; ADR 0008. CONTEXT.md already lists `do-not-wait` as a deferred join mode —
   update it to shipped when this lands.
5. **Acceptance** — one **synthetic** `do-not-wait` workflow (§1: no real driver): a block that fires a
   side-effect branch and moves on, exercising launch-and-continue, the enclosing-run barrier, `publish`
   rejection at load, failure isolation, and resume re-fire. Marked synthetic in the acceptance NOTES,
   like the deliberately-absent items already are.

## 11. Out of scope

- **Per-branch / mixed detach** — flagging *some* branches of a block detached while others are waited.
  `do-not-wait` is a **whole-block** join mode (every branch detaches), symmetric with `collect` /
  `wait-one`. A per-branch detach axis is a larger surface with its own output/publish/failure rules; it
  gets its own door if a real workflow ever wants it.
- **Outlive-the-root (true detach)** — a branch that survives past `path run` returning, engine-tracked
  or fully fire-and-forget (Unix `&`). This spec deliberately keeps the tree strictly nested (§1.1);
  true detach shatters the cancel/resume/cost model wholesale and is a separate, larger redraw.
- **Launch manifest output** — a block output listing the fired branch names (§3). No use case; `{}` is
  the minimal honest value.
- **A `do-not-wait` resume short-circuit** — deliberately *not* built (§7); re-running a non-`succeeded`
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
