# `wait-one` join — feature spec

**Status:** Design signed off (grilling session, 2026-08-08). A decision opened this door, not a fired
trigger. The `wait-one` / `do-not-wait` row in the [v-next register (#109)]
(https://github.com/howardyang2009/PATH/issues/109) named the trigger: "a workflow that races two
sources and wants first-wins". The maintainer chose to build ahead of that evidence. Only `wait-one`
is in scope here. `do-not-wait` stays parked (see §10).

This spec is normative for the `wait-one` join mode. It extends `mvp-spec.md` §5.2, §5.4, and §5.6,
and `workflow-format-v0.md` §10. Those sections point here.

## 1. Summary

A `parallel` block's `join` gains a second value: `wait-one`. `collect` waits for **every** branch and
lands them all. `wait-one` **races** the branches and keeps the **first to succeed**. It cancels the
other branches. Use it to produce a result in two or more ways and take whichever branch wins.

```
parallel, join: wait-one
  branch fast-api:    step → publish { answer }
  branch web-scrape:  step → publish { answer }
next step: input ← context.answer
```

## 2. Join semantics

- **Winner rule — first-to-succeed.** The winner is the first branch to reach `succeeded`. The engine
  **ignores a branch that fails**. The race continues with the branches that still run. This is
  different from a "first-to-finish" rule. Under first-to-finish, one fast failure would end the race
  and (fail-fast) fail it. The chosen rule keeps the race robust when a losing branch breaks.
- **All branches fail.** If every branch fails, the block **fails**. It surfaces a **synthetic
  aggregate error** ("all N `wait-one` branches failed"). This error is distinct from any single
  branch's error. Each branch already records its own failure on its own run row. There is no winner,
  so the engine emits **no `join-applied` event** (§8).
- **Failure does not cross-cancel.** Under `collect`, a failing branch cancels its in-flight siblings
  (`sibling-failed`). Under `wait-one`, a failing branch cancels **nothing**, because the race is still
  live. `wait-one` causes only one cancellation: it cancels the **losers when a winner appears** (§5).

## 3. Output object

The block keys its output under a **stable** `winner` key:

```json
{ "winner": { "name": "<winning-branch-name>", "output": <winner's last-node output object> } }
```

This spec uses a fixed key instead of `collect`'s `{branch-name: output}` shape. The author **cannot
know which branch wins**. Thus a branch-name key would be unaddressable by a static `input` ref.
`winner.output` always resolves. `winner.name` records who won, for downstream logic (the human branch
`name`, not the GUID — ADR 0007). This satisfies the one-output-object rule (§5.4).

## 4. Context and publishes

`wait-one` inherits `collect`'s context model unchanged. It narrows one thing at the join:

- **Snapshot isolation (unchanged).** Each branch runs against a snapshot of context. The engine takes
  the snapshot at block entry (`mvp-spec.md` §5.3). Siblings never see each other's writes during the
  race.
- **Publishes buffer (unchanged).** A branch holds its publishes in a per-branch buffer. Nothing
  reaches shared context during the race.
- **Winner-only lands (new — the pinned rule).** At the join, **only the winner's buffered publishes
  land**. Every non-winner is failed or cancelled. A failed or cancelled branch lands nothing
  (`mvp-spec.md` §5.6). Thus the rule follows directly: *"A `wait-one` join lands the winner's buffered
  publishes only."* A failed branch's write can never reach the next node.
- **Absence, not contamination, is the caller's risk.** A losing branch can publish a key that the
  winner does not. That key never lands. A later node that reads it finds it missing. This is the "only
  the winner's writes exist" property. It is the author's burden, not an engine fault.

### 4.1 Same-key publish across siblings

`workflow-file.ts` statically rejects sibling parallel branches that publish the same context key. That
ban is **correct for `collect`**: all branches land, and two writes to one key are a nondeterministic
last-writer race. It is **wrong for `wait-one`**: only one branch's publishes ever land, so two
branches that publish `answer` are deterministic. That is the *headline* pattern. The check becomes
**join-aware**:

- `collect` — the engine **rejects** same-key siblings at load (unchanged).
- `wait-one` — the engine **allows** same-key siblings.

Without this change, the natural race-two-sources workflow fails to load. The author must then use
distinct keys plus a downstream unwrap. That unwrap cannot name the winner. It reintroduces the
unaddressable-key problem that §3 solves for the block output.

## 5. Cancellation

When a winner appears, the engine cancels the still-running losers **best-effort**. It reuses the
existing sibling-cancellation machinery (it kills the processor, holds no deadline, and has no force
path). The cancellation carries a **new cause**, `sibling-succeeded`:

> `run-cancelled` causes are now **`operator` | `sibling-failed` | `sibling-succeeded`**.
> `sibling-succeeded` — a `wait-one` branch reached `succeeded`, so the still-running losers of the
> race are cancelled.

To reuse `sibling-failed` would make the audit lie, because nothing failed. A cancelled loser lands no
publishes. It ends `cancelled`, a distinct status from `failed`.

## 6. Winner determination and tie-break

The engine serializes completion observations. `seq` is monotonic per root run: "the ordering truth"
(CONTEXT.md, *Log event*). The winner is the branch whose `succeeded` observation carries the **lowest
`seq`**. The event loop serializes completions, so there is no true simultaneity. Thus no secondary
tie-break (for example, declaration order) is needed.

## 7. Resume interaction

Resume is **cause-blind**. It re-runs every node that is not `succeeded`. It reuses every node that is
`succeeded` ([ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md)). Consider a replay of a decided
`wait-one` race. The winner's step run is `succeeded`, so resume reuses it. The losers were
**cancelled** (`sibling-succeeded`), not `succeeded`. The cause-blind rule would otherwise **re-run**
them. To re-run the losers of an already-won race is pure waste. Resume is **at-least-once**, so it
could **re-fire their side effects**.

The resolution: **the join re-evaluates and short-circuits.** A `wait-one` is a **logicer**. It has no
run of its own. The engine re-evaluates it on resume, as it does `branch` and `while-do`. On replay,
it finds the winner's run reused as `succeeded`. Thus *first-to-succeed is already satisfied*, and it
**starts no loser at all**. It creates no loser run, so cause-blindness has nothing to act on. This
adds no exception to the resume rule. (The rule governs runs, and here no run starts.) **ADR 0004**
captures it: *"`wait-one` resume re-evaluates the join; a reused winner short-circuits its losers."*

## 8. Edge cases

- **Single-branch `wait-one`** — legal (`branches.min(1)` unchanged). It is a degenerate one-runner
  race. There is no special case.
- **`join-applied` event** — gains a `winner` field that carries the winning branch name. It fires
  **only** when a winner lands. It never fires on all-fail (§2).

## 9. Build order

Order the commits by dependency. Keep them small. Repo rule: `main` is protected, PR-only, and CI
`test` must be green.

1. **Schema** (`packages/schema`)
   - `nodes.ts:68` — widen `join: z.literal("collect")` to `z.enum(["collect","wait-one"])`.
   - `workflow-file.ts:71-95` — make `findDuplicatePublishKeys` join-aware. Thread the parent
     `parallel.join`. Skip the same-key ban under `wait-one` (§4.1).
   - Tests: accept `wait-one`; `collect` same-key still rejects; `wait-one` same-key passes; single
     branch is ok.
2. **Event + cause** (`packages/schema/log-event.ts`, `packages/engine/run-observer.ts`)
   - Add `sibling-succeeded` to the `run-cancelled` cause union (`log-event.ts:81`,
     `run-observer.ts:128`).
   - Add `winner` to `JoinAppliedSchema` (`log-event.ts:71`).
3. **Engine race** (`packages/engine/run-workflow.ts`, parallel executor ~133-217, 486-614)
   - `wait-one` path: race the branches. The first `succeeded` (lowest `seq`) wins. Cancel the
     in-flight losers with cause `sibling-succeeded`. A branch failure does **not** cancel siblings.
     All-fail gives an aggregate block failure.
   - Land the winner's buffer only. Discard the loser buffers. The block output is
     `{winner:{name,output}}`. Emit `join-applied{winner}` on success. Emit none on all-fail.
4. **Resume re-eval** (§7) — resume path. The `wait-one` logicer checks for a reused `succeeded` child
   before it launches. If it finds one, it satisfies the join and starts no losers.
5. **Docs** — update `mvp-spec.md` §5.2, §5.4, §5.6, and the §467 row; `workflow-format-v0.md` §10; and
   ADR 0004. CONTEXT.md is already updated (*Cancellation*, *Join mode*).
6. **Acceptance** — one real `wait-one` workflow (race two sources, same publish key). It must exercise
   winner-lands, loser-cancel, and resume short-circuit.

## 10. Out of scope

- **`do-not-wait`** — stays parked in the #109 register. It means fire-and-forget branches: detached
  runs that outlive the block. `mvp-spec.md` §5.2 ("no detached runs") forbids them. The run tree's
  cancel, resume, and cost model all key against them. It is a **redraw** of the destination, not an
  addition. It gets its own design when its trigger fires.

## References

- Register: [#109](https://github.com/howardyang2009/PATH/issues/109)
- `mvp-spec.md` §5.2–5.6, §5.7
- `workflow-format-v0.md` §10
- CONTEXT.md — *Cancellation*, *Join mode*, *Log event*
- [ADR 0001 — resumed run is a successor run](../adr/0001-resumed-run-is-a-successor-run.md)
- ADR 0004 (to be written) — `wait-one` resume short-circuit
