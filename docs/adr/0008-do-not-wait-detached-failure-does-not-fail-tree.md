# A `do-not-wait` detached branch failure does not fail its tree

Status: accepted

The engine's standing rule is **fail-fast**: a failed descendant run fails its ancestor. A step failure
fails its run (`mvp-spec.md` §5.6), and a failing `collect` parallel branch fails its block and cancels
its in-flight siblings (`sibling-failed`). Adding the `do-not-wait` join
([spec](../spec/do-not-wait-join.md)) puts that rule in tension with what `do-not-wait` is *for*. A
`do-not-wait` branch is fire-and-forget: the block launches it and moves on, the main path never reads
it, and the enclosing workflow-run merely **awaits** it at its exit barrier (spec §2). If such a branch
fails, propagating that failure up the tree would fail a run whose *main path* succeeded — on the
strength of a branch the author explicitly chose not to wait for.

Resolution: **a `do-not-wait` branch failure is isolated — it is recorded on the branch's own run row
and its own `step-finished` log event, and it does not fail the enclosing run.** A workflow-run may end
`succeeded` with a `failed` `do-not-wait` branch in its subtree. The failure is fully auditable (queryable
on the run row, filterable in `path runs list`); isolation means it does not **propagate**, not that it is
hidden.

## Considered Options

- **Propagate — a failed detached branch fails its tree (fail-fast, unchanged).** Faithful to the
  standing invariant with no new rule. Rejected: it makes a run's status depend on a branch nobody waited
  for, directly contradicting the join the author chose. A `do-not-wait` block would then be unable to
  express "kick this off and don't let its outcome gate me" — the block's entire purpose. It also makes
  the run's terminal status **nondeterministic in practice**: whether the failure lands before or after
  the main path completes would decide whether it is observed, an unstable outcome for a branch that is
  supposed to be irrelevant.
- **Cross-cancel on detached failure (like `collect`).** Rejected for the same reason `wait-one` rejects
  it: the siblings are independent work in no race, and the main path has already moved on, so there is
  nothing a cancellation would correctly stop.
- **Isolate — record the failure, do not propagate.** Chosen. The failure lives where it belongs (the
  branch's own run row and log event), and the tree's status follows the path the author actually made
  the tree wait on. The invariant break is real but narrow and named, rather than the join silently
  meaning something the fail-fast rule contradicts.

## Consequences

- **The fail-fast invariant gains one scoped exception, and only one.** "A failed descendant fails its
  ancestor" now reads "…except a `do-not-wait` branch, whose failure is isolated." The exception is
  confined to this one join mode; `collect` and `wait-one` failure propagation are untouched. This is the
  single reason `do-not-wait` earns an ADR where the rest of its design does not.
- **A `succeeded` run may contain a `failed` descendant.** Downstream status logic and any tooling that
  reasons over a run tree (`path runs list`, cost/audit views) must not assume a `succeeded` root implies
  an all-`succeeded` subtree. The `failed` branch row is present and queryable; consumers filter on it if
  they care.
- **No effect on cost.** The roll-up is status-blind (spec §8): the failed branch's burned tokens still
  count toward the root figure. Isolation is about status propagation, not accounting.
- **No new cancellation cause and no resume change.** Isolation removes any sibling-driven cancel path
  (spec §6), so the `run-cancelled` cause union is unchanged, and resume stays cause-blind (spec §7,
  contrast [ADR 0004](0004-wait-one-resume-short-circuit.md)). This ADR governs failure *propagation*
  alone.
- **Auditability is preserved, not traded away.** The choice is deliberately "do not propagate," not "do
  not record." An operator can always see that a detached branch failed; they simply do not have the run
  fail out from under them because of it.
