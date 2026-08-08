# `wait-one` resume re-evaluates the join; a reused winner short-circuits its losers

Status: accepted

Resume is **cause-blind** ([ADR 0001](0001-resumed-run-is-a-successor-run.md), `mvp-spec.md` §5.6): a
successor run re-runs every node that is not `succeeded` and reuses every one that is, regardless of
*why* a node stopped. Adding the `wait-one` join ([spec](../spec/wait-one-join.md)) puts that rule in
tension with the join's own cancellation. A decided `wait-one` race leaves its **winner** `succeeded`
and its **losers** `cancelled` (cause `sibling-succeeded`). On a naive cause-blind replay the winner is
reused, but the losers — not `succeeded` — would **re-run**, re-racing a contest already won.

Resolution: **the `wait-one` logicer re-evaluates on resume, and a reused `succeeded` winner satisfies
the join before any loser is launched.** A `wait-one` is a **logicer** — it has no run of its own
(invariant 1); the engine re-evaluates it on replay exactly as it re-evaluates `branch` and `while-do`.
On replay it finds the winner's run reused as `succeeded`, so first-to-succeed is already met, and it
**starts no loser run at all.**

## Considered Options

- **Cause-blind, no exception — re-run the losers.** Faithful to the one-line resume rule with no
  new machinery. Rejected: it re-runs the losers of a race that is already decided (the winner is
  reused and lands at the join), which is pure wasted work and — resume being **at-least-once**
  (`mvp-spec.md` §5.6) — can **re-fire a loser's external side effects**. It also has no coherent
  meaning: the join already has its winner, so a re-run loser cannot become one.
- **Special-case the losers as terminal-for-resume.** Teach resume that a `sibling-succeeded`
  cancellation is "done, do not re-run." Rejected: it carves a cause-specific exception into the
  cause-blind rule — precisely the coupling ADR 0001 keeps out — and it reasons about the loser
  *runs* when the real actor is the join above them.
- **Re-evaluate the logicer; a reused winner short-circuits.** Chosen. The decision lives where it
  belongs — in the join, which is engine-evaluated fresh on every replay — and the losers are never
  launched, so there is no loser run for cause-blindness to have an opinion about. The resume rule is
  untouched: it still governs runs, and here no run is started.

## Consequences

- **The resume rule stays cause-blind and exception-free.** It governs runs; the `wait-one`
  short-circuit prevents loser runs from ever being *started*, so it needs no carve-out. The two
  mechanisms compose rather than special-casing each other.
- **Idempotency burden shrinks for `wait-one` losers specifically.** A resumed workflow will not
  re-fire the side effects of a race's losers, even though resume is at-least-once in general. This is
  a property of the join, not a weakening of the at-least-once contract — a re-run *winner* (if the
  winner itself had not succeeded) still fires at-least-once like any other node.
- **The engine's resume path must consult reused child status when re-evaluating a `wait-one`
  logicer** — before launching any branch, check whether a branch's terminal step run is reused as
  `succeeded`. If one is, satisfy the join from it (lowest `seq` wins on the reused observations, same
  tie-break as a live race, §6 of the spec) and launch nothing. The exact reuse lookup rides on the
  reuse-marker back-reference ADR 0001 already requires.
- **No new format or CLI surface.** This is engine replay behavior; the `wait-one` format shape
  (§3, §4.1 of the spec) is unaffected by whether a run is fresh or resumed.
