# Context under `goto` is one last-writer-wins blackboard across passes

**Status:** accepted. Resolves context and publish behavior under cycles for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#598](https://github.com/howardyang2009/PATH/issues/598). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (goto execution
model), [ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) (pass containers) and
[ADR 0037](0037-while-do-iteration-is-a-per-iteration-run-scope.md) (while-do shares the enclosing
context). Plan-only: no engine code yet.

A backward `goto` re-runs first-level nodes in the same workflow-run, against the same context
blackboard, so a revisited node's `publish` lands again and overwrites keys it, or a later node,
already wrote. A forward jump skips nodes, which then never publish. This ADR decides what the
blackboard does across passes.

## Decision

1. **Last-writer-wins, nothing is reset.** Every pass shares the workflow-run's one blackboard (ADR
   0054 §3). A jump, forward or backward, neither snapshots, rolls back nor clears any key. In
   `[A, B, check]` where `check` jumps back to `B`, pass 2's `B` sees everything pass 1 published,
   including keys a later node wrote, until a node publishes them again. This is exactly `while-do`
   today (ADR 0037), and carrying keys across passes is the point of the loop: a retry reads the last
   `verdict`.

2. **An unwritten key is an ordinary interpolation error.** Reading `${context.x}` when no node has
   published `x` on the path taken fails the reading node at runtime with the existing
   `InterpolationError` ("cannot resolve"), whether the writer was skipped by a forward jump or has not
   run yet on the first visit. No load-time dataflow check is added and no default syntax
   (`${context.x ?? …}`) is added. An author seeds a loop-carried key through the workflow's input,
   which seeds the context (format §6.3), or the launch `--context` seed.

3. **Each visit keeps its own context snapshot; a pass keeps none.** A succeeded leaf writes its
   per-step `context.json` under its own run directory, and every visit has its own run id (ADR 0054
   §8), so every visit's context stays followable with no change. A `pass` container writes no
   snapshot of its own, as an `iteration` container writes none: the last leaf snapshot in the pass
   already holds the blackboard at jump time.

4. **A revisited `parallel` joins like a first join.** A goto never sits under `parallel` (ADR 0053
   §3), so a jump never interrupts a join and publish buffering stays inside one pass. A first-level
   `parallel` that is a jump target lands its buffered publishes at its join on every visit, and a
   `wait-one` join may pick a different winner per visit. The load-time publish-set checks (disjoint
   `collect` siblings, empty `do-not-wait` branches) are per structure and do not change.

5. **Resume-from-K across passes is fixed by #608, not here.** Resume restores a re-entered
   workflow-run by loading its predecessor's *final* `context.json`, then reused nodes re-publish. A
   Resume-from-K into pass 1 therefore sees keys that only passes 2..N wrote, unless a node before K
   publishes them again. Plain Resume-from-K has the same gap today; goto makes it common.
   [#608](https://github.com/howardyang2009/PATH/issues/608) replaces restore-by-load with replay from
   the seed (the predecessor's `input.json`) for every file, so K sees the context it saw originally.
   Goto adds no rule of its own. Landed as
   [ADR 0062](0062-resume-rebuilds-context-by-replay-from-the-seed.md).

## Considered options

- **Snapshot the blackboard when a pass opens and roll back on a jump.** Rejected: it breaks the one
  shared blackboard of invariant 4, and a retry could no longer read what the failed attempt
  published.
- **Clear the jump target's publish set on a backward jump.** Rejected for the same reason, and
  `while-do` has no such rule.
- **A load-time "may be unwritten on some path" check.** Rejected: with goto, whether a key is written
  depends on the path taken, so a static check either rejects valid loops or passes everything.
- **A default-value interpolation syntax.** Rejected: new grammar, and ADR 0055 §5 already refused to
  widen interpolation for goto.
- **Restore Resume context from each reused step's per-step `context.json`.** Rejected in favor of
  #608's replay from seed: only executed leaf steps snapshot (none for a nested `workflow` step,
  a reuse row, a controller or a `parallel` join), trees before 2026-08-22 have none, and snapshots
  are secret-masked.

## Consequences

- The goto engine work adds nothing to context handling: the top-level walk threads the same `exec`
  context through every pass, as `runWhileDoNode` threads it through every iteration container.
- Authors of goto loops must seed any key that a node reads before its writer's first visit.
