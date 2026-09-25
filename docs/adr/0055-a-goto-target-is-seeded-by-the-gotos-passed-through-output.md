# A goto target is seeded by the goto's passed-through output

**Status:** accepted. Resolves input seeding for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#549](https://github.com/howardyang2009/PATH/issues/549). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (goto execution
model) and [ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) (pass containers).
Plan-only: no engine code yet.

Every step has exactly one input object (invariant 3). Today a step's input is its own `input` map,
interpolated against `config` and `context`, when it declares one; otherwise it is the incoming
output of the node before it in the walk (`runNode` in `packages/engine/src/run-workflow.ts`). A
`goto` carries only a target step id (#478), so after a jump the target has no lexical predecessor
whose output it can take. ADR 0053 already makes the goto `SeqOutcome` carry `output`, the goto's
own incoming output unchanged, and left open whether that seeds the target.

## Decision

1. **Pass-through.** The goto's incoming output becomes the jump target's incoming output. The
   target resolves its input exactly as any step does: its own `input` map when it declares one,
   otherwise that incoming output. A goto directly in a branch arm passes through the branch's
   incoming output, which is the output of the first-level node before the branch. This is the same
   default-input chain `while-do` uses, where iteration N-1's output seeds iteration N.

2. **One rule in both directions.** A forward jump seeds the target from the goto, never from the
   target's lexical predecessor: that node was skipped and has no output in this pass. A backward
   jump does the same.

3. **A revisit is a fresh run with its own input.** When a backward jump reaches a target that already
   ran with a different input, nothing compares the two inputs or reuses the earlier visit. Each visit
   is its own run in its own pass (ADR 0054) and records its own input. What the earlier visit left on
   the context blackboard is out of scope here (#598).

4. **A pass container records its seed.** A `pass` container's `run-started` input is the seed its
   first node receives: the workflow-run's input for pass 1, and the opening goto's passed-through
   output for pass N. This mirrors the `iteration` container, and puts the jump's carried value in the
   record although the goto itself has no run row (invariant 1).

5. **No new interpolation root.** The interpolation scope stays `config` + `context`. No `${goto.*}`
   or `${previous.*}` root is added: no step can reference its incoming output by path today, and
   goto does not open that door.

## Considered options

- **Target reads context; nominal input `{}`.** Rejected: every target without an `input` map
  would receive `{}` after a jump but a real object on its first visit, so the same node behaves
  differently depending on how it was reached.
- **A required input field on goto.** Rejected: it duplicates the target's own `input` map and gives
  an author two places to set one seed.
- **Seed a forward-jump target from its lexical predecessor.** Rejected: the predecessor did not run
  in this pass, so there is no output to take.
- **A `${goto.*}` / `${previous.*}` interpolation root.** Rejected (rule 5).

## Consequences

- The top-level walk, on consuming a `goto` outcome, sets its carried value to the outcome's `output`
  before it re-seeks, and hands that value to the next pass's container as its input.
- Resume needs nothing new for seeding: a reused pass's nodes replay their recorded outputs, so the
  goto that ends it passes through the same value the original run did.
- Left to sibling tickets: context and publish under cycles (#598), replay divergence (#599), the
  `goto-taken` payload (#600). **Amended (#600):** decided in [ADR 0061](0061-goto-taken-and-goto-exhausted-are-walk-emitted-control-events.md).
