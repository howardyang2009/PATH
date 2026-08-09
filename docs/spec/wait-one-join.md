# `wait-one` join — feature spec

**Status:** Design signed off (grilling session, 2026-08-08). This door was opened **by decision**, not
by a fired trigger — the `wait-one` / `do-not-wait` row in the [v-next register (#109)]
(https://github.com/howardyang2009/PATH/issues/109) named the trigger "a workflow that races two
sources and wants first-wins"; the maintainer chose to build ahead of that evidence. Only `wait-one`
is in scope here. `do-not-wait` stays parked (see §10).

This spec is normative for the `wait-one` join mode. It extends `mvp-spec.md` §5.2, §5.4, §5.6 and
`workflow-format-v0.md` §10; those sections are updated to point here.

## 1. Summary

A `parallel` block's `join` gains a second value, `wait-one`. Where `collect` waits for **every**
branch and lands them all, `wait-one` **races** the branches and keeps the **first to succeed**,
cancelling the rest. It is the join for "produce this result two (or more) ways, take whichever wins."

```
parallel, join: wait-one
  branch fast-api:    step → publish { answer }
  branch web-scrape:  step → publish { answer }
next step: input ← context.answer
```

## 2. Join semantics

- **Winner rule — first-to-succeed.** The winner is the first branch to reach `succeeded`. A branch
  that **fails is ignored**: the race continues with the branches still running. This deliberately
  differs from a "first-to-finish" rule, under which one fast failure would end (and, fail-fast,
  fail) the whole race. The chosen rule keeps the race robust to a losing branch breaking.
- **All branches fail.** If every branch fails, the block **fails**. It surfaces a **synthetic
  aggregate error** ("all N `wait-one` branches failed"), distinct from any single branch's error;
  each branch's own failure is already recorded on its own run row. No winner, so **no `join-applied`
  event** is emitted (§8).
- **Failure does not cross-cancel.** Under `collect`, a failing branch cancels its in-flight siblings
  (`sibling-failed`). Under `wait-one`, a failing branch cancels **nothing** — the race is still live.
  The only cancellation `wait-one` causes is of the **losers, when a winner appears** (§5).

## 3. Output object

The block's output is keyed under a **stable** `winner` key:

```json
{ "winner": { "name": "<winning-branch-name>", "output": <winner's last-node output object> } }
```

A fixed key was chosen over `collect`'s `{branch-name: output}` shape because the author **cannot know
which branch wins**, so a branch-name key would be unaddressable by a static `input` ref. `winner.output`
always resolves; `winner.name` records who won for downstream logic (the human branch `name`, not the
GUID — ADR 0007). This satisfies the one-output-object rule (§5.4).

## 4. Context and publishes

`wait-one` inherits `collect`'s context model unchanged, with one narrowing at the join:

- **Snapshot isolation (unchanged).** Each branch runs against a snapshot of context taken at block
  entry (`mvp-spec.md` §5.3). Siblings never see each other's writes during the race.
- **Publishes buffer (unchanged).** A branch holds its publishes in a per-branch buffer; nothing
  reaches shared context mid-race.
- **Winner-only lands (new — the pinned rule).** At the join, **only the winner's buffered publishes
  land.** Every non-winner is failed or cancelled, and a failed/cancelled branch lands nothing
  (`mvp-spec.md` §5.6), so this follows directly: *"A `wait-one` join lands the winner's buffered
  publishes only."* A failed branch's write can therefore never reach the next node.
- **Absence, not contamination, is the caller's risk.** If a losing branch would have published a key
  the winner does not, that key never lands, and a later node reading it finds it missing. This is the
  "only the winner's writes exist" property — the author's burden, not an engine fault.

### 4.1 Same-key publish across siblings

`workflow-file.ts` statically rejects sibling parallel branches publishing the same context key. That
ban is **correct for `collect`** (all branches land; two writes to one key is a nondeterministic
last-writer race) and **wrong for `wait-one`** (only one branch's publishes ever land, so two branches
publishing `answer` is deterministic and is the *headline* pattern). The check becomes **join-aware**:

- `collect` — same-key siblings **rejected** at load (unchanged).
- `wait-one` — same-key siblings **allowed**.

Without this relaxation the natural race-two-sources workflow fails to load, and the author is forced
into distinct keys plus a downstream unwrap that cannot name the winner — reintroducing the
unaddressable-key problem §3 solves for the block output.

## 5. Cancellation

When a winner appears, the still-running losers are cancelled **best-effort**, reusing the existing
sibling-cancellation machinery (processor killed, no deadline, no force path). The cancellation carries
a **new cause**, `sibling-succeeded`:

> `run-cancelled` causes are now **`operator` | `sibling-failed` | `sibling-succeeded`**.
> `sibling-succeeded` — a `wait-one` branch reached `succeeded`, so the still-running losers of the
> race are cancelled.

Reusing `sibling-failed` would make the audit lie (nothing failed). A cancelled loser lands no
publishes and ends `cancelled` (a distinct status from `failed`).

## 6. Winner determination and tie-break

Completion observations are serialized by the engine and `seq` is monotonic per root run — "the
ordering truth" (CONTEXT.md, *Log event*). The winner is the branch whose `succeeded` observation
carries the **lowest `seq`**. Because the event loop serializes completions there is no true
simultaneity, so no secondary tie-break (e.g. declaration order) is needed.

## 7. Resume interaction

Resume is **cause-blind**: it re-runs every node that is not `succeeded` and reuses every one that is
([ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md)). Replaying a decided `wait-one` race, the
winner's step run is `succeeded` (reused) while the losers were **cancelled** (`sibling-succeeded`) —
not `succeeded` — which the cause-blind rule would otherwise **re-run**. Re-running the losers of an
already-won race is pure waste and, resume being **at-least-once**, could **re-fire their side effects**.

Resolution: **the join re-evaluates and short-circuits.** A `wait-one` is a **logicer** — it has no run
of its own; the engine re-evaluates it on resume as it does `branch` and `while-do`. On replay it finds
the winner's run reused as `succeeded`, so *first-to-succeed is already satisfied*, and it **starts no
loser at all.** No loser run is created, so there is nothing for cause-blindness to act on. This adds no
exception to the resume rule (which governs runs; here no run is started). Captured as
**ADR 0004** — *"`wait-one` resume re-evaluates the join; a reused winner short-circuits its losers."*

## 8. Edge cases

- **Single-branch `wait-one`** — legal (`branches.min(1)` unchanged). A degenerate one-runner race; no
  special case.
- **`join-applied` event** — gains a `winner` field carrying the winning branch name. Fires **only**
  when a winner lands; never on all-fail (§2).

## 9. Build order

Dependency-ordered, small commits. Repo rule: `main` protected, PR-only, CI `test` green.

1. **Schema** (`packages/schema`)
   - `nodes.ts:68` — widen `join: z.literal("collect")` → `z.enum(["collect","wait-one"])`.
   - `workflow-file.ts:71-95` — make `findDuplicatePublishKeys` join-aware: thread the parent
     `parallel.join`, skip the same-key ban under `wait-one` (§4.1).
   - Tests: accept `wait-one`; `collect` same-key still rejects; `wait-one` same-key passes; single
     branch ok.
2. **Event + cause** (`packages/schema/log-event.ts`, `packages/engine/run-observer.ts`)
   - Add `sibling-succeeded` to the `run-cancelled` cause union (`log-event.ts:81`,
     `run-observer.ts:128`).
   - Add `winner` to `JoinAppliedSchema` (`log-event.ts:71`).
3. **Engine race** (`packages/engine/run-workflow.ts`, parallel executor ~133-217, 486-614)
   - `wait-one` path: race branches; first `succeeded` (lowest `seq`) wins; cancel in-flight losers with
     cause `sibling-succeeded`; a branch failure does **not** cancel siblings; all-fail → aggregate block
     failure.
   - Land the winner's buffer only; discard loser buffers; block output `{winner:{name,output}}`; emit
     `join-applied{winner}` on success, none on all-fail.
4. **Resume re-eval** (§7) — resume path: the `wait-one` logicer checks for a reused `succeeded` child
   before launching; found → satisfy the join, start no losers.
5. **Docs** — `mvp-spec.md` §5.2 / §5.4 / §5.6 / §467 row; `workflow-format-v0.md` §10; ADR 0004.
   CONTEXT.md already updated (*Cancellation*, *Join mode*).
6. **Acceptance** — one real `wait-one` workflow (race two sources, same publish key) exercising
   winner-lands, loser-cancel, and resume short-circuit.

## 10. Out of scope

- **`do-not-wait`** — stays parked in the #109 register. It means fire-and-forget branches — detached
  runs that outlive the block — which `mvp-spec.md` §5.2 ("no detached runs") forbids and the run
  tree's cancel / resume / cost model all key against. It is a **redraw** of the destination, not an
  addition, and gets its own design when its trigger fires.

## References

- Register: [#109](https://github.com/howardyang2009/PATH/issues/109)
- `mvp-spec.md` §5.2–5.6, §5.7
- `workflow-format-v0.md` §10
- CONTEXT.md — *Cancellation*, *Join mode*, *Log event*
- [ADR 0001 — resumed run is a successor run](../adr/0001-resumed-run-is-a-successor-run.md)
- ADR 0004 (to be written) — `wait-one` resume short-circuit
