# `goto` is a `SeqOutcome` jump caught by a per-file top-level walk

**Status:** accepted. Resolves the goto execution model for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#546](https://github.com/howardyang2009/PATH/issues/546); origin
[#478](https://github.com/howardyang2009/PATH/issues/478). Plan-only: no engine code yet.

`goto` (#478) sets the engine's next step to a named **first-level** step of the current workflow
file, backward jumps (cycles) included. Execution today is one recursive walk, `runSequence`
(`packages/engine/src/run-workflow.ts`), a strict `for...of` with no program counter, serving every
body alike: a file's top-level body, each `sequence`, `parallel` branch, branch arm and loop
iteration. This ADR decides how a jump is executed, not how its repeated visits are identified,
seeded, audited, resumed or rendered (those are sibling tickets under #544).

## Decision

1. **Only a file's top-level body gets a program counter.** A new *top-level walk* (an index loop
   with a jump register) replaces `runSequence` for the top-level body in `executeWorkflowRun`'s
   `runBody`. Every nested body (`sequence`, `branch` arm, `while-do` iteration, `parallel` branch)
   stays on `runSequence`, unchanged. A goto target is always a first-level step (#478), so the
   top-level body is the only list a jump can land in; Structure Controllers keep their
   single-entry, single-exit, one-visit-per-node block semantics (ADR 0029).

2. **A jump is a `SeqOutcome` variant: `{ status: "goto"; target: <node GUID>; output: JsonValue }`.**
   `runNode` returns it for a goto node (a worker-less controller: no task, no run, invariant 1).
   `target` is the target node's stable id (ADR 0006); `output` is the goto's incoming output passed
   through unchanged (whether it seeds the target's input is the input-seeding ticket's call). Every
   nested walker already returns any non-`succeeded` outcome early, so `runSequence`, `branch` and
   `sequence` carry it upward with no new code, exactly as they carry `awaiting`. Only the top-level
   walk consumes it: it re-seeks its index to `target` and continues. Because `SeqOutcome` is a
   discriminated union, every site that must refuse or handle the variant is found by the compiler,
   not at runtime.

3. **Placement: a goto sits at the first level, or inside a first-level `branch`'s arm** (directly in
   the slot, or under any nesting of `sequence` and `branch` below it). Never under `while-do` or
   `parallel`, so a jump never has to close a loop-iteration container (ADR 0037) or cancel running
   siblings. A goto **target** is never an inner node of `branch`, `sequence`, `while-do` or
   `parallel`. Both rules are load-time validation.

4. **"First level" is per file, and a jump never crosses a file boundary.** Every workflow-run's
   `runBody`, root or nested, runs its own top-level walk, so a `workflow`-ref file may use goto
   within itself. A goto's target resolves in the goto's own file. A child's goto is always consumed
   by the child's own walk; `runWorkflowNode` receives a `RunResult`, which has no `goto` variant, so
   a jump cannot leak into the parent by construction. A `workflow` step is an ordinary first-level
   step and may be a target in its own file.

5. **Non-termination: an authored `max_jumps` on every goto node, default 3.** Like `while-do`'s
   `max_iterations`, it is a positive integer or a string interpolating to one. The count is **per
   goto node, per workflow-run** (a re-run `workflow` step's fresh child run starts at zero). The
   authored *guard* is the enclosing branch arm's `when`; `max_jumps` is the backstop.

6. **Exhausting `max_jumps` fails the run.** Reaching a goto whose jumps are spent fails the
   workflow-run (e.g. `goto "retry": max_jumps (3) exhausted`), as an exhausted `while-do` does:
   nodes after the goto may assume its loop resolved, so silent fall-through would ship a wrong
   result. An author who wants "try N times, then continue" says so in the branch condition.

## Considered options

- **A jump register inside `runSequence` for every body.** Keeps one walker, but every nested walk
  carries a register it can never use. Rejected for option 1.
- **The top-level walk inspects `node.type === "goto"` directly.** Works only for a first-level goto,
  which is useless alone (an unconditional backward jump never terminates). Rejected: the conditional
  goto lives in a branch arm.
- **A thrown `GotoSignal` exception.** Invisible to the type system; no exhaustiveness check forces a
  walker to decide. Rejected for the `SeqOutcome` variant.
- **Goto under `while-do` / `parallel`.** Would require finishing iteration containers or cancelling
  siblings mid-jump. Rejected (option 3).
- **An engine-only jump budget with no authored field.** Keeps #478's one-field node, but gives an
  author no way to set the bound where the loop is written. Rejected for `max_jumps` (option 5).
- **Fall through when `max_jumps` is spent.** Rejected (option 6).

## Consequences

- `runSequence` stops being the only walker: its "single owner of how a body is walked" docstring
  narrows to nested bodies, and the top-level walk is the second, `runBody`-only walker.
  `NodeExecContext.walk` still hands out `runSequence`.
- A first-level node may now run more than once in one workflow-run. How each visit is keyed
  (research takeaway 2: per-visit keys, not node re-identification), what the target's input is, the
  `goto-taken` audit event, publish/context behavior under cycles, and Resume / Complete replay
  correctness (including rebuilding the per-goto jump counts from the record) are open under #544.
- Forward jumps skip nodes; a skipped node produces no run row.
- Per the prior-art research (#547), this matches BPMN's same-scope link events and the
  authored-guard-plus-backstop pattern of every durable engine surveyed.
