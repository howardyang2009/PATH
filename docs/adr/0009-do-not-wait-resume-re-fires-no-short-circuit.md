# `do-not-wait` resume re-fires its branches; no short-circuit

Status: accepted

Resume is **cause-blind** ([ADR 0001](0001-resumed-run-is-a-successor-run.md), `mvp-spec.md` §5.6): a
successor run re-runs every node that is not `succeeded` and reuses every one that is, and it is
therefore **at-least-once** — a re-run node can re-fire an external side effect. The sibling join
`wait-one` departs from that default: [ADR 0004](0004-wait-one-resume-short-circuit.md) has its resume
re-evaluate the join and short-circuit the losers, so a decided race is not re-run. Adding `do-not-wait`
([spec](../spec/do-not-wait-join.md)) raises the obvious question: should its detached branches be
short-circuited on resume the same way?

A `do-not-wait` branch is fire-and-forget — the block launches it and moves on, and the main path never
reads it. If such a branch stopped non-`succeeded` in the predecessor (it failed, was cancelled, or was
still live when the tree was frozen), a naive cause-blind replay re-runs it, and — resume being
at-least-once — its external side effect (a Slack post, a webhook) can fire **again**.

Resolution: **`do-not-wait` keeps the cause-blind default with no short-circuit.** A non-`succeeded`
detached branch re-runs on resume like any other node, its side effect may double-fire, and idempotency
is the author's burden — the same burden every step already carries. This is a deliberate divergence
**from** `wait-one`'s ADR 0004, not an oversight, and it is recorded so a reader comparing the two joins
finds the reasoning rather than a contradiction.

## Considered Options

- **Cause-blind, no short-circuit — re-run non-`succeeded` branches.** Chosen. A `do-not-wait` branch is
  **independent** work in no race, its outcome decided by nothing. To a cause-blind resume, a branch that
  did not reach `succeeded` is ordinary **unfinished work**, and re-running it is the resume contract
  doing exactly its job. It adds nothing to the resume rule — it simply obeys it — so it needs no engine
  machinery and no carve-out. The at-least-once double-fire is the same property, and the same author
  burden, that every step already lives under.
- **Short-circuit like `wait-one` (mirror ADR 0004).** Rejected. `wait-one`'s short-circuit is justified
  by its **race**: the losers are made pointless by a reused winner, so re-running them re-litigates a
  contest already settled and the join has no use for them. A `do-not-wait` branch has no winner, no
  race, and nothing that makes it pointless — so "already decided, do not re-run" has no meaning here.
  Mirroring ADR 0004 would suppress work that is genuinely unfinished, defeating the resume contract for
  no benefit the author cannot get by writing an idempotent step.
- **A `do-not-wait`-specific resume exception (mark detached branches terminal-for-resume).** Rejected
  for the same reason ADR 0004 rejected the analogous option for `wait-one` losers: it carves a
  mode-specific exception into the cause-blind rule — the coupling ADR 0001 keeps out — and buys nothing,
  since the honest behavior (re-run unfinished work) is already what cause-blind gives.

## Consequences

- **`do-not-wait` adds nothing to the resume contract.** Where `wait-one` needed ADR 0004 because it
  *departs* from cause-blind, `do-not-wait` needs no such departure — it is the default. The engine's
  resume path is unchanged beyond accepting the new `join` value; the only resume-specific work is a test
  asserting a non-`succeeded` detached branch **re-runs** (locking in the *absence* of a short-circuit so
  no future change quietly adds one).
- **Detached side effects can double-fire on resume, and that is the documented contract.** An author who
  puts a non-idempotent side effect in a `do-not-wait` branch owns the duplicate, exactly as they would
  in any other step. The spec (§7) warns about this at the point of use.
- **The two joins now read consistently once the race distinction is seen.** `wait-one` short-circuits
  because its non-`succeeded` branches are *decided losers*; `do-not-wait` re-runs because its
  non-`succeeded` branches are *undecided, independent work*. The divergence is a consequence of what each
  join means, not an inconsistency in the resume model.
