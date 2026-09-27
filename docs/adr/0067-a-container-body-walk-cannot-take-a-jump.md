# A container body's walk cannot take a jump

**Status:** accepted. Amends the justification, not the decision, of
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md); leans on the load
refusal of [ADR 0058](0058-a-goto-is-target-plus-max-jumps-in-path-workflow-5.md).

ADR 0053 made a `goto` a **`SeqOutcome`** variant and justified the shape with "because `SeqOutcome`
is a discriminated union, every site that must refuse or handle the variant is found by the compiler,
not at runtime". That property does not hold. The container runners test individual status literals
rather than switching on the discriminant, so adding the variant produced no compile error at any of
them, and the three sites disagreed about an impossible value:

- `runLoopIteration` threw at runtime — a state the load refinement makes unreachable (`gotoIssues`
  refuses a goto under `while-do`), so the throw was dead code guarding nothing.
- A `collect` join mapped every non-`succeeded` branch outcome to `null`, so a jump that reached the
  join would have been dropped silently, its buffered publishes landed, and the block reported
  success with a `null` output.
- `do-not-wait` discarded each branch outcome entirely.

The value is unreachable only because `@path/schema` refuses the file at load. Nothing in the engine's
types said so, and nothing stopped a future container runner from mishandling it the same way.

## Decision

1. **A jump stays a `SeqOutcome` variant.** A walk that may legally take one — the top-level walk of a
   file, a `branch` arm, a nested `sequence` — must be able to hand it up.
2. **A container body gets a walk whose result has no jump.** `@path/engine` gains
   `BodyOutcome = Exclude<SeqOutcome, { status: "goto" }>`, and `NodeExecContext` carries a second
   walker, `bodyWalk: NodeBodyWalk` (returning `BodyOutcome`), beside the existing `walk`.
3. **Two kinds of caller, named by the field they take.** The top-level walk and `runBranchNode` use
   `walk`; `runLoopIteration` and every `run-parallel` branch use `bodyWalk`.
4. **One adapter is the only way in.** `runContainerBody` runs `runSequence` and turns an escaped jump
   into a `failed` outcome naming the goto (`goto "x": a jump may not leave a while-do or parallel
   body`). An unreachable value fails the run loudly instead of crashing the process or vanishing into
   a join.
5. **The dead guards go.** `runLoopIteration`'s throw and its pre-check are deleted; a `goto`
   comparison against a `BodyOutcome` is now a type error.

## Considered Options

- **Two walkers, narrow for containers** (chosen). Keeps the injected-walk structure that breaks the
  `run-node` ↔ control-runner import cycle, and makes the illegal value unrepresentable where it would
  be mishandled.
- **Return `{ outcome, jump? }` from every walk** (ADR 0053's implied alternative). Strictly stronger,
  but it changes the seam every caller and every node-level test touches, for a distinction only the
  top-level walk consumes.
- **Keep one walker and centralize the runtime check.** Rejected. It leaves the union's jump variant in
  every container runner's hands; the compiler still finds nothing.
- **Delete the `goto` variant and carry jumps on `RunContext`.** Rejected. A jump must stop the
  enclosing walk before its next node, so it is a control-flow result, not run state.

## Consequences

- **A skipped load fails closed.** A hand-built file (or a future load path that forgets the check)
  that puts a goto under a `while-do` or `parallel` ends the run with a named error, rather than
  dropping the jump.
- **Container runners handle four outcomes.** `BranchResult["outcome"]` is a `BodyOutcome`, and the
  join's output map no longer has an impossible branch to account for.
- **The `walk` injection test moves to `bodyWalk`** (`run-parallel.test.ts`), since a branch is walked
  through the container walker.
- **A new container runner is a type decision.** Taking `bodyWalk` means the runner cannot receive a
  jump; taking `walk` means it must expect one.
- **`CONTEXT.md` needs no change.** The glossary already says a goto may not sit under `while-do` or
  `parallel`, and a jump is consumed by the file's top-level walk.
