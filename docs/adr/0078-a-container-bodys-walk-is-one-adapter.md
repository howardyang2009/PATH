# A container body's walk is one adapter, not a second injected walker

**Status:** accepted. Supersedes decisions 2–4 of
[ADR 0067](0067-a-container-body-walk-cannot-take-a-jump.md); keeps its decision 2's outcome type
and the load refusal it leans on ([ADR 0058](0058-a-goto-is-target-plus-max-jumps-in-path-workflow-5.md)).

ADR 0067 gave `NodeExecContext` **two** injected walks — `walk` (may hand up a `goto`) and `bodyWalk`
(returns `BodyOutcome`, which has no jump variant) — plus a third runner, `runContainerBody`, whose
only job was to run `runSequence` and turn an escaped jump into a named failure. The intent was that
a container runner could not mishandle an impossible value.

The cost was paid everywhere else:

- every container runner and every node-level test had to pick the right walker by hand, and
  `makeExec` in two suites had to construct both;
- `runContainerBody` was a second runner over the same loop, so "walk a body" was three functions in
  three files (`runSequence`, `runContainerBody`, `runTopLevelWalk`);
- the walk-injection test had to move to `bodyWalk` (ADR 0067's own consequence), because the seam it
  was testing was no longer where branches walked;
- the value both walkers fence off is already refused at load (ADR 0058), so the second walker's type
  narrowness guarded a path only a skipped load can reach.

## Decision

1. **`NodeExecContext` carries one walk**, `walk: NodeWalk`, still injected so a control runner never
   imports the runner that dispatches it.
2. **`walkContainerBody(run, nodes, seed, exec)` is the only way a container body walks.** It calls
   `exec.walk`, returns `BodyOutcome`, and turns an escaped jump into the named failure the run would
   otherwise mishandle.
3. **`BodyOutcome` stays the container runners' outcome type** (`BranchResult["outcome"]`), so the
   impossible value is still unrepresentable where it would be mishandled — at the runner, not at the
   injection point.
4. **`runContainerBody` is deleted**, and `runSequence` is once again the one body runner.

## Considered Options

- **Two injected walks** (ADR 0067's choice). Rejected now: the same guarantee is available from one
  adapter, at a cost the container runners and their tests no longer pay.
- **One walker with the runtime check centralized.** ADR 0067 rejected this because the union's jump
  variant stayed in every container runner's hands. That objection does not hold here: the adapter
  returns `BodyOutcome`, so a runner that asks for a body never sees a jump.
- **Carry a jump on `RunContext` instead of the outcome.** Still rejected (ADR 0053): a jump must stop
  the enclosing walk before its next node, so it is a control-flow result.

## Consequences

- **The fail-closed guard is a function, not a field.** `run-node.test.ts` and `run-parallel.test.ts`
  still pin it: a `goto` that reaches a container body fails the run by name.
- **A new container runner calls `walkContainerBody`** to receive the narrow outcome; calling
  `exec.walk` directly is possible and would reintroduce the hazard, as it was before ADR 0067.
- **Every node-level test constructs one walk**, and the branch-walk injection test drives `walk`
  again.
