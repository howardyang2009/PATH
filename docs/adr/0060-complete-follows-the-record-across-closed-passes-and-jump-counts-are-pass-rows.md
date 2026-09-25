# Complete follows the record across closed passes; a goto's jump count is its pass rows

**Status:** accepted. Resolves Resume and Complete replay correctness under `goto` for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#599](https://github.com/howardyang2009/PATH/issues/599). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (execution model),
[ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md) (pass containers),
[ADR 0055](0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md) (pass seed),
[ADR 0039](0039-complete-is-a-durable-engine-re-invocation-over-the-appendable-tree.md) and
[ADR 0041](0041-awaiting-continue-is-a-replay-from-root-over-the-appendable-tree.md) (Complete replay).
Plan-only: no engine code yet.

Replay today re-evaluates every `branch` condition fresh; no branch outcome is recorded. Under `goto`
that means a replay re-decides every jump, against a workflow file Complete reloads and may find edited.
A jump closes its pass (ADR 0054 §1), so a parked `person-activity` leaf always sits in the **last**
pass, the one `running` pass; every earlier pass is `succeeded` history. Each closed pass is already
fully recorded: pass k+1's `nodeId` names the goto that fired, and its `run-started` input is the value
that goto carried (ADR 0055 §4).

## Decision

1. **Complete follows the record across closed passes.** The Complete replay does not re-walk passes
   1..N-1. It reads the `pass` rows of the workflow-run, takes the one `running` pass N, and re-enters
   it in place by its `pass` ordinal (the Complete adapter's lookup gains the `pass` scope beside
   `iteration`). No closed-pass condition is re-evaluated, no closed-pass goto fires again. Inside pass
   N the walk behaves as today: succeeded rows are read, the parked leaf is completed, conditions are
   evaluated fresh. Because exactly one pass is `running` and later passes do not exist yet, the replay
   re-enters one row and never mints a second pass N.

2. **The running pass starts at its opening goto's target, checked against the record.** For pass 1
   the start is index 0. For pass N the replay resolves the opening goto (the pass row's `nodeId`) in
   the reloaded file and seeks to its target. The resolved target must be pass N's first recorded
   child node (lowest `seq` under the pass). If the goto is gone, or its target differs, the tail fails
   the workflow-run: `Complete replay diverged: pass N was opened by goto "<G>" whose target is now
   "<X>", recorded "<Y>"`. The leaf's output is already committed, so an operator's Resume reuses it
   and handles the divergence by ADR 0054 §5.

3. **Resume re-decides jumps.** A Resume successor is a new run, allowed to take another path after an
   edit. It re-evaluates conditions fresh and pairs passes by ordinal and opening goto (ADR 0054 §5);
   Resume-from-K inside a pass is ADR 0054 §6. Nothing new here: the asymmetry with rule 1 is the
   decision worth recording.

4. **A goto's jump count is the number of passes it opened in this workflow-run.** `max_jumps` (ADR
   0053 §5) is spent as `count(pass rows whose nodeId = G)`, under the workflow-run. One rule serves
   both modes: a Complete finds the rows already there; a Resume successor mints its own pass rows as
   its walk jumps, so the count grows with the walk. The `goto-taken` event (#600) is an audit trail,
   not a source of engine state, and need not carry anything for recovery.

5. **Rule 1 depends on Complete restoring context by load.** Complete loads the workflow-run's own
   `context.json`, the exact blackboard at park time (ADR 0041; #608 keeps Complete out of its
   replay-from-seed change). That blackboard already holds every closed pass's publishes, so skipping
   the closed passes loses nothing. Any future move of Complete to replay-from-seed must replay the
   closed passes' publishes in recorded `seq` order.

## Considered options

- **Complete re-walks closed passes with fresh conditions** (one mechanism with Resume). Rejected: an
  edited condition or a shifted context value can send the walk elsewhere, so it never reaches the
  running pass, and the only exits are failing the tree or minting a second pass N (breaking the
  in-place invariant). Complete is the same run with one leaf finished (ADR 0039); closed jumps are
  facts, not decisions to retake.
- **Start the running pass at its recorded first child, ignoring the goto.** Rejected: a deleted or
  moved target node leaves no index to seek to.
- **Re-seek to the goto's current target without a check.** Rejected: pass N's rows would no longer
  match the walk, and nodes could run twice.
- **Rebuild jump counts from `goto-taken` events.** Rejected: it makes the log a source of engine
  state; the run tree already is one.
- **An in-memory counter rebuilt by the replay.** Rejected: it needs the replay to re-walk every jump,
  which rule 1 refuses.

## Consequences

- `continuation.ts`: the Complete adapter's `findExistingChild` gains a `pass` scope; the top-level
  walk, under Complete, skips to the running pass instead of starting at pass 1.
- The top-level walk reads jump counts from the pass rows of its workflow-run (Complete) or counts the
  passes it opens (fresh walk and Resume); both are the same number.
- ADR 0053 and ADR 0054 carry `**Amended (#599).**` pointers where they left replay to #599.
