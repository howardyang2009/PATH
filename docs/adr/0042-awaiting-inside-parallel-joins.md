# Awaiting inside a parallel block is a live branch member; the join's existing rules reach it unchanged

Status: accepted

An `awaiting` leaf (a parked person-activity step, [ADR 0038](0038-awaiting-is-a-leaf-only-status-parents-do-not-propagate.md)) that sits inside a parallel branch is an ordinary non-terminal member of that branch. It invents no join-mode special case: each join's existing resolution and cancellation rules apply to a parked branch exactly as they apply to a `running` one. We considered exempting an `awaiting` branch from join cancellation and rejected it.

## What each join does with an awaiting branch

- **collect** waits for every branch. Several branches may each hold an `awaiting` step; each resolves independently on its own Complete, in any order, and the join lands when the last one resolves. The root stays `running` throughout (ADR 0038). A sibling **failure** fires the existing `sibling-failed` cancellation, which cancels the still-`awaiting` branches: the person's pending offline activity is abandoned, the leaf moves to `cancelled`, and a later Complete for it lands `409` (not-`awaiting`). This is collect's existing fail-fast reaching an `awaiting` leaf, not a new rule.
- **wait-one** races for the first branch to **succeed**. An `awaiting` branch is a live racer, not a disqualified one. It **wins** if its Complete lands before any sibling succeeds (it reaches `succeeded` first, and the losing siblings are cancelled `sibling-succeeded`). It is **cancelled** (`sibling-succeeded`) if a sibling succeeds first: the parked human activity is abandoned, the leaf moves to `cancelled`, and a later Complete lands `409`. A cancelled branch lands no publishes. These are the two faces of one rule; neither exempts the `awaiting` branch.
- **do-not-wait** may contain a person-activity step **iff that step's publish set is empty** — the ordinary detached-branch rule, keyed on declared `publish` keys, not on the completion output. A person-activity step is not special here: with no `publish` keys it is legal; with them it is a load error like any other node. A legal detached branch that parks `awaiting` holds the enclosing workflow-run barrier open until the person Completes (the engine awaits each detached branch at that barrier), so the root stays `running` (ADR 0038); the block's own join still completed at once with output `{}`.

## Resume

An `awaiting` step is non-terminal, so it is never reused. A branch parked `awaiting` and never Completed is non-succeeded, so Resume re-runs it: the person-activity worker returns `{ status: "awaiting" }` again and the branch parks fresh. For a `do-not-wait` detached branch this is [ADR 0009](0009-do-not-wait-resume-re-fires-no-short-circuit.md)'s re-fire with no short-circuit, now stated for the awaiting case; for `collect` and `wait-one` it is the cause-blind resume rule reaching a non-succeeded branch.

## Considered options

- **Exempt an `awaiting` branch from join cancellation.** A `wait-one` win or a `collect` sibling-failure would leave the parked branch alive rather than cancel it. Rejected: it lets one person sitting on an offline activity hold an already-decided join open for days, which defeats the point of `wait-one` (losers abandoned) and collect's fail-fast. It also demands a brand-new "`awaiting` is un-cancellable" carve-out that nothing else in the cancellation model has, and it reasons about the parked leaf when the real actor is the join above it.

## Consequences

- The parallel joins gain no new code path for `awaiting`. `sibling-failed` and `sibling-succeeded` already cancel non-terminal branches; an `awaiting` leaf is one such branch. No new cancel cause is added.
- A Complete that arrives for an already-cancelled branch is a plain `409` not-`awaiting` (the leaf's status is now `cancelled`), the same taxonomy the Complete route already defines (#466).
- Status propagation is untouched: a tree parked entirely on people still reads `running` at the root (ADR 0038). This ticket does **not** adopt the "root becomes `awaiting`" rule that #467 floated; ADR 0038 governs.
