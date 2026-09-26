# Resume rebuilds a re-entered workflow-run's context by replay from its seed

**Status:** accepted. Resolves [#608](https://github.com/howardyang2009/PATH/issues/608), raised by the
grilling of [#598](https://github.com/howardyang2009/PATH/issues/598)
([ADR 0059](0059-context-under-goto-is-one-last-writer-wins-blackboard-across-passes.md) §5).
Supersedes the restore-by-load rule of
[resume-restore-semantics.md §1–2](../archive/research/resume-restore-semantics.md) **for Resume only**.
Complete ([ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md)) keeps
restore-by-load.

Until now a re-entered workflow-run on Resume loaded its predecessor counterpart's **final**
`context.json` verbatim, and reused nodes then re-applied their `publish` in walk order. The research
doc argued that load and replay give the same bytes. That holds for plain Resume, where every node
after the resume point is re-run anyway. It does not hold for **Resume-from-K**: the final
`context.json` already holds keys written by nodes after K, and any key that no node before K
publishes again leaks into K's view.

Example: the input seeds `y=0`. `A` publishes `x=1`, `B` reads `y`, `C` publishes `y=5`. Resume from
K=`B` loads `{x:1, y:5}`, `A` re-publishes `x=1`, and `B` re-runs reading `y=5`, not `0`. A re-run
`while-do` is worse: its condition reads keys its own past iterations wrote, so it can skip the loop.
`goto` ([ADR 0059](0059-context-under-goto-is-one-last-writer-wins-blackboard-across-passes.md)) makes
this common, because a Resume-from-K into pass 1 would see every key that passes 2..N wrote.

## Decision

1. **A re-entered workflow-run starts from its seed.** On Resume, a workflow-run that has a
   counterpart in the predecessor tree seeds its context from what that counterpart started from,
   never from its final `context.json`. This covers the root run and every re-entered nested
   workflow-run. `while-do` iteration containers and (once they exist) goto pass containers share the
   enclosing run's context (ADR 0037, ADR 0054), so the enclosing run's replay covers them.

2. **The reused prefix replays the rest.** Reused nodes already re-apply their `publish` in walk order
   against their recorded `output.json` (`runNode`). After each reused node the context therefore
   equals what that node saw originally, and K sees exactly the context it saw originally. A reused
   `parallel` `collect` join re-lands every branch's buffered publish at the join in branch
   declaration order; a reused `wait-one` join re-lands only the recorded winner's. The existing
   reuse path already does both; #608 adds tests that pin it.

3. **Where each seed comes from.**
   - **Root:** a Resume carries no input of its own (`--context` and `--resume` stay mutually
     exclusive). The launch `--context` seed is folded into the root run's effective input
     (`effectiveRootInput`), so the counterpart root's `input.json` records it. The root seeds from
     that blob, uses it as the first node's default input, and records it again as its own
     `run-started` input, so a Resume of the successor replays from the same seed.
   - **Nested:** a re-entered nested workflow-run seeds from its own freshly interpolated `input`.
     The parent replayed to the context it had originally, so this equals the counterpart's recorded
     `input.json`. It also keeps real secret values, where the recorded blob holds mask tokens.

4. **Secrets come back real.** A replayed `publish` of `${config.<secret>}` is interpolated again
   against the recovered config, which the Resume supplies again (ADR 0046). It yields the real value,
   not the `[secret:<key>]` token that a masked `context.json` holds. The same holds for a secret in a
   nested run's `input` (§3).

5. **A run with no counterpart is unchanged.** It is a first attempt and seeds fresh from its input
   (invariant 4).

## Considered options

- **Keep restore-by-load.** Rejected: it is wrong for every Resume-from-K whose suffix writes a key
  that the prefix does not write again.
- **Restore from each reused step's per-step `context.json` snapshot.** Rejected: only executed leaf
  steps snapshot. There is none for a nested `workflow` step (its directory's `context.json` is the
  child's isolated blackboard), none for a reuse row, none for a controller and none after a
  `parallel` join. Trees before `0b899a6` (2026-08-22) have no snapshots, and snapshots are
  secret-masked.
- **Apply replay to Complete too.** Rejected: Complete has no K. Loading its own `context.json` is
  already the exact parked state.

## Consequences

- Resume reads the root counterpart's `input.json` instead of `context.json`, and no blob at all for
  a nested re-entered run. Every tree since #72 records `input.json` on each workflow-run's
  `run-started`, so no migration is needed.
- A successor tree written before this ADR recorded `{}` as its root `input.json`. A Resume of such
  a successor starts from `{}`, not the original launch seed. Resume the original tree instead.
- `resume-restore-semantics.md` §1–2 now points here. The "load equals replay" argument remains true
  only for plain Resume.
