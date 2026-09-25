# `goto-taken` and `goto-exhausted` are control events the top-level walk emits

**Status:** accepted. Resolves the goto audit event for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#600](https://github.com/howardyang2009/PATH/issues/600). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (execution model),
[ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) (pass containers, `pass-started`)
and [ADR 0060](0060-complete-follows-the-record-across-closed-passes-and-jump-counts-are-pass-rows.md)
(jump counts are pass rows). Plan-only: no engine code yet.

A goto is a worker-less controller (invariant 1): it has no run, so like `branch-taken` and
`loop-exited` its effect reaches the log only through a control event. The jump is decided in two
places. The goto node returns a `goto` `SeqOutcome` deep inside a branch arm, and the top-level walk
consumes it. Only the walk knows how many jumps the goto has spent (the pass rows, ADR 0060 §4) and
which pass the jump opens.

## Decision

1. **The top-level walk emits both events, when it consumes a `goto` outcome.** The walk that
   decides the jump, counts it and opens the pass also reports it. The `goto` `SeqOutcome` gains the
   goto's own node id beside `target` (`{ status: "goto"; goto: <node GUID>; target: <node GUID>;
   output: JsonValue }`); the pass row's `nodeId` needs it anyway (ADR 0054 §3).

2. **The envelope follows the control-event rule.** `run_id` is the enclosing workflow-run, never a
   pass container, as for every control event (a `branch-taken` inside a `while-do` iteration also
   carries the workflow-run). `node_id` / `node_name` name the goto node. A reader who wants the
   pass reads the `pass` field.

3. **`goto-taken` records one jump.** Payload: `target_node_id`, `target_node_name`, `jump` (1-based
   count of this goto's jumps in the workflow-run, this one included), `max_jumps` (the resolved
   integer, since the authored value may interpolate) and `pass` (the ordinal of the pass the jump
   opens). Forward and backward jumps alike. No remaining count (`max_jumps - jump`), no closing-pass
   ordinal (`pass - 1`), no direction: each is derivable. No condition trace: a goto has no
   condition, the `branch-taken` just before it already carries the arm's trace, and an unguarded
   first-level goto has none. Its outcome in the client is `null`, like `branch-taken`.

4. **`goto-exhausted` records a goto whose `max_jumps` is already spent** (ADR 0053 §6). Payload:
   `target_node_id`, `target_node_name`, `max_jumps` and `pass` (the ordinal of the pass that fails).
   No jump happens, so there is no `jump` field. Its client outcome is `failed`, like `branch-no-match`.
   `goto-taken` therefore always means a jump happened.

5. **Order is cause first.** One jump: `goto-taken`, the closing pass's `step-finished` (succeeded),
   the new pass's `step-started`, `pass-started`, then the target's `step-started`. Exhaustion:
   `goto-exhausted`, the pass's `step-finished` (failed), the workflow-run's `step-finished` (failed).

6. **Each tree narrates its own jumps.** A Complete does not re-walk closed passes (ADR 0060 §1), so
   it emits no `goto-taken` for them. A Resume successor re-decides every jump (ADR 0060 §3), so it
   emits a fresh `goto-taken` for each jump its walk takes, including a jump into a pass it pairs and
   reuses. The events are audit only; nothing reads them back into engine state (ADR 0060 §4).

7. **Viewer: an event line, no new tree shape.** The message reads, e.g., `goto check jumped to B ·
   jump 2/3 · pass 3` and `goto check exhausted · max_jumps 3 · target B`. The run tree shows a jump
   only as the pass row, already labelled "Pass N" with its opening goto (ADR 0054). A drawn edge
   between siblings is left to Designer rendering (#601).

## Considered options

- **The goto node emits `goto-taken` inside `runNode`.** Rejected: it would need the spent count and
  the next pass ordinal, which every nested walker (`branch`, `sequence`) would have to thread down,
  and the jump would be decided in one place and reported in another.
- **`run_id` is the closing pass.** Rejected: goto would be the one control event off the rule, and
  whether the event belongs to the closing or the opening pass has no good answer.
- **Carry the enclosing arm's condition trace.** Rejected: a duplicate of `branch-taken`'s trace,
  masked twice, and absent for an unguarded goto.
- **`goto-taken` with a refusal reason for exhaustion.** Rejected: "taken" would lie.
- **No event for exhaustion, only the failed `step-finished` error.** Rejected: a spent bound has its
  own control signal today (`loop-exited` with `max-iterations-exceeded`).
- **Carry `remaining` instead of `max_jumps`.** Rejected: a reader then needs the workflow file to
  know the bound.

## Consequences

- `LogEvent` and the engine observation union gain `goto-taken` and `goto-exhausted`; `run-emitter`,
  `logging-observer`, `persisted-observer`, `secret-mask`, `event-message` and `event-outcome` each
  gain the two cases, and the exhaustiveness guards find every site. The payloads hold ids, names
  and integers, so the masker has no value to scrub.
- Every persisted log line is re-validated on read, so a field added to either event later needs a
  default (as `run-cancelled.cause` did). The payload is fixed here for that reason.
- ADR 0053, 0054, 0055 and 0060 carry `**Amended (#600)**` pointers where they left the event to
  this ticket.
