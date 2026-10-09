# The Resume plan is part of the Continuation it serves

**Status:** accepted.

The Resume plan had its own module (`resume-plan.ts`): nine exports — `rootResumeEntry`,
`resolveResume`, `resumeSeed`, `enterNested`, `enterIteration`, `passResumer`, their working types
`ResumeEntry`/`RunResume`/`RerunPathLevel`, and a `recordedChild` re-export. Only two production
call sites crossed it, both inside `continuation.ts` except `run-workflow.ts`'s `rootResumeEntry`,
and `resumeFromResume` already held the `RunResume` and threaded the plan's operations itself.
Everything else that named the module was a test reaching six internal `enter…` functions, past the
`Continuation` interface the walkers actually cross.

## Decision

1. **`resume-plan.ts` is folded into `continuation.ts`**, under a `── The Resume plan ──` section.
   The scope kinds — root entry, nested `workflow`, `while-do` iteration, goto pass — and the three
   adapters (`noContinuation`, `resumeContinuation`, `completeContinuation`) now sit in one module.
2. **The plan's working types and helpers are internal.** `ResumeEntry` stays exported because it is
   `resumeContinuation`'s parameter; `RunResume`, `RerunPathLevel`, `resolveResume`, `resumeSeed`,
   `enterNested`, `enterIteration` and `passResumer` are implementation.
3. **The module's tests move to the seam.** `resume-plan.test.ts` is replaced by scope-kind cases in
   `continuation.test.ts` that drive `resumeContinuation(...).enter(...)` and assert on the returned
   `Continuation`'s `disposition`, instead of calling the `enter…` helpers through their own
   interface. `recordedChild` keeps its tests in `plan-reuse.test.ts`.

## Consequences

- Resume pairing (which recorded row is a scope's counterpart, which children reuse) has one home,
  so a change to the boundary or the pass rule cannot land in one module and miss the other.
- `run-workflow.ts` imports `rootResumeEntry` from `continuation.ts`; nothing imports
  `resume-plan.ts`.
- One fewer module in the engine's import graph, and the tests that remain cross the interface the
  walkers use.
