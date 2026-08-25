# Resume door — is a succeeded run's recorded output reusable at all?

This is the decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#145](https://github.com/howardyang2009/PATH/issues/145): whether the **resume** door may hand a
downstream step a recorded `output.json` instead of a re-run of the step that produced it, and if so,
under what rule.

This is the **crux of the map**, not a side question.
[#142](https://github.com/howardyang2009/PATH/issues/142) locks that *every token this door saves is
saved by trust in a recorded success*. Cause-blindness makes a re-run cheap to *specify* but saves
nothing by itself. If reuse is unsound, the door does not open regardless of what
[#144](https://github.com/howardyang2009/PATH/issues/144)'s crash artifact costs. This ticket settles
soundness **before** the kill-run produces a number, so the verdict in
[#150](https://github.com/howardyang2009/PATH/issues/150) cannot be back-fitted to a reuse rule chosen
to fit the measurement.

It decides **semantics only**: the unit and legitimacy of reuse. It does **not** decide how to compute
whether a recorded input still holds (that is [#146](https://github.com/howardyang2009/PATH/issues/146)),
nor what a re-run of an already-half-landed step owes an at-least-once world
([#147](https://github.com/howardyang2009/PATH/issues/147)), nor any CLI/format/engine surface (the next
map's, only if the door opens).

## The rule

> A resumed run reuses the recorded `output.json` of **every succeeded run whose input object still
> holds**, and re-runs every other run in the tree. Reuse spans `binary` and `prompt` runs alike. It is
> not gated on determinism. The unit is the **run**, keyed on `(node, input object)`. To reuse a
> succeeded workflow-run's output skips its whole subtree, the collapsed form the rule takes for free
> whenever nothing inside the subtree changed.

This qualifies [#142](https://github.com/howardyang2009/PATH/issues/142)'s one-liner. That map states
the cause-blind rule as *"re-runs every run in the tree that is not `succeeded`, and reuses the recorded
output of every run that is."* True, but only under **unchanged inputs**.
[#142](https://github.com/howardyang2009/PATH/issues/142) also locks that *inputs may change between
attempts* (fresh `--config`/`--set`, a re-read workflow file). Those two locked decisions are in
tension: the moment an input can change, "reuse every succeeded run" is wrong for the succeeded runs
whose input changed. The qualifier **whose input still holds** resolves it. To compute "still holds" is
[#146](https://github.com/howardyang2009/PATH/issues/146)'s job. This ticket only establishes that the
qualifier is needed and that the unit it attaches to is the run.

## Why the rule is sound

Five findings, in dependency order. Each rests on the domain model as written
([CONTEXT.md](../../CONTEXT.md), [mvp-spec](../spec/mvp-spec.md)); none requires a new invariant.

### 1. A succeeded run's `output.json` is the step's product, not a proxy for its execution

When the engine replays a recorded output instead of a re-execution, it asserts exactly *"this task, on
this input object, already ran to `succeeded` and produced this output object"*, nothing more. That
satisfies the workflow author's contract, because a PATH step's contract is **invariant 3**: *consume
one input object, emit one output object.* It is not *"emit the output a fresh execution would emit."*
The output object is the sole channel by which a step affects anything downstream (invariant 3), so the
recorded `output.json` is not a lossy stand-in for re-execution. It is the exact artifact re-execution
exists to produce.

CONTEXT.md already carries this in the Secret rule: *"a **succeeded** run's output is the product, and
an operator is owed the real answer."* Replay is honest on the same ground: the engine claims the step
*did* this, never that it *would do it again*.

The contrary reading, that a step's contract is with its *execution*, so replay is a substitution the
author never authorized, is what would sink the door. It does not hold: PATH nowhere promises
re-execution equivalence, and invariant 3 makes the output object the whole of what a step means
downstream.

### 2. Nondeterminism changes reuse's *value*, not its *legitimacy*

A `binary` step over a pinned input is reproducible; an LLM step is not. The tempting objection is that
a recorded LLM output is *unverifiable*: you cannot check the record is still the answer the step would
give. But that assumes a canonical *"the answer the step would give"* to check against. For a
nondeterministic step **no such referent exists**: a fresh LLM run is equally unverifiable against
*another* fresh LLM run. "The record might not match a re-execution" is not a defect of replay; it is
the fact that the step has no single answer, already true when the step first ran. Finding 1 settled
that the contract is for *an* answer, not *the* answer.

So a nondeterministic step has strictly **more** right to reuse, not less. To re-run destroys a real
answer and gains no verification, because there was never anything to verify against. The reproducible
`binary` case, where reuse looks safest, is where it buys least, because the door's money is in the LLM
tail. Verifiability and value point the **same** way: reuse LLM outputs.

Rejected: to gate reuse on determinism (reuse `binary`, re-run `prompt`). It buys no safety (finding 2)
and guts the economics (finding 5).

### 3. The dead session removes nothing the output object doesn't already hold

An LLM chat session cannot be resumed across processes. A resumed run necessarily gets new processors,
and the session that produced a recorded LLM output no longer exists. This does **not** make a replayed
LLM output different in kind, because of **§5.5**: *"a step reads exactly what its `input` map builds —
no hidden conversational state."* A `prompt` run spawns a fresh session, does one turn, and is torn
down. Nothing about the step survives in the session that is not in the output object (invariant 3
forbids any other downstream channel). The dead session carried no information `output.json` lacks.

This inverts the worry into support: the **no-session-reuse contract is the precondition** that makes
`output.json` a complete substitute for the run. If §5.5's deferred session-pooling optimization ever
ships, a downstream step could depend on live conversational state, and a dead session *would* be a
hole; replay would be lossy. The stateless-processor rule closes that hole in advance.

**Forward dependency:** this finding is contingent on §5.5's no-session-reuse rule. If session pooling
lands, reuse-of-recorded-output must be re-examined; the two features interact.

### 4. The unit is the run, keyed on `(node, input object)`; per-subtree is its collapsed form

> **Superseded in part by [#146](https://github.com/howardyang2009/PATH/issues/146)**
> ([resume-invalidation-semantics.md](resume-invalidation-semantics.md)): the key this finding proposes,
> `(node, input object)`, gated by an equality check, is narrowed to `(node id, status)`, and drops the
> input-object comparison. #146 was #145's own delegate for *how* to compute "still holds"; it answers
> "trivially, by status alone." The unit-is-the-run and per-subtree-collapse claims below are
> unaffected; only the equality-gate mechanism changes. Left as originally written for the historical
> record.

A workflow-run succeeded means every child run succeeded (fail-fast), and by invariant 3 it has a single
output object. Two reuse granularities are conceivable: reuse the parent's output object and skip the
whole subtree, or walk the tree and reuse child-by-child. Under **unchanged inputs** they produce
identical downstream data, so reuse at the highest succeeded run is both correct and cheapest.

The tie-breaker is input-change, which [#142](https://github.com/howardyang2009/PATH/issues/142) admits
into scope:

- Input object **unchanged** from the recorded attempt: the recorded output still answers this input, so
  reuse the whole subtree, skip it entirely.
- Input **changed** (operator re-set config that feeds the subtree, or the re-read file altered a
  child): the parent's recorded output no longer answers *this* input, so the subtree re-runs, and reuse
  resumes at whichever children still have unchanged inputs.

So reuse is fundamentally **per-run with an input-equality gate**. Per-subtree is the collapse you get
for free when nothing in the subtree changed. This is why
[#142](https://github.com/howardyang2009/PATH/issues/142) spun *what invalidates a succeeded run's
reuse* into [#146](https://github.com/howardyang2009/PATH/issues/146): that ticket owns the equality
predicate (and any workflow-file fingerprint). #145 needs only that the unit is the run and per-subtree
is a valid collapse.

### 5. The counterfactual confirms the rule rather than threatening it

The conservative alternative [#142](https://github.com/howardyang2009/PATH/issues/142) names, *re-run
everything not yet consumed, keep only cheap deterministic outputs*, folds two narrowings, both of which
fail to pay:

- **Deterministic-only** (reuse `binary`, re-run every `prompt`) is self-defeating. The bar's kill
  points sit in the LLM tail: B and C are *inside the `revise` prompt of the second `while-do`
  iteration* ([bar §4](resume-door-bar.md)). Cost is `estimatedCostUsd` plus `usage`, populated
  **leaf-only on prompt runs** (§5.7). To re-run every prompt reuses exactly the outputs that cost
  nothing and re-burns exactly the ones that cost everything, so residual is about gross re-burn, and the
  door cannot clear even the 10% floor. This is
  [#142](https://github.com/howardyang2009/PATH/issues/142)'s *"token saving rests entirely on reuse"*
  stated in reverse.

- **Consumed-only** (reuse only outputs already read downstream) is a category error. Whether a
  downstream step already *read* an output changes nothing about what the output *is* (finding 1).
  "Consumed" is the reader's progress, not the producer's validity. A succeeded-but-unconsumed LLM output
  is exactly as reusable, same `output.json`, same cost to regenerate. To gate on consumption re-burns
  the freshest, deepest outputs (the tail) for a distinction with no soundness content.

The counterfactual therefore **proves the main rule**: the only reuse rule that pays is the broad one
(every succeeded run whose input holds, LLM included), and findings 1 to 3 established that rule is
sound. Finding 2's "reuse LLM outputs" is not merely *permitted*; it is **load-bearing**: the door exists
only if LLM reuse is legitimate. There is no conservative refuge: broad-reuse-or-nothing.

## How this constrains the artifact

[#144](https://github.com/howardyang2009/PATH/issues/144) measures **gross re-burn** as the spend a
from-scratch rerun repeats over *every run that had already succeeded when the kill landed*. This ticket
fixes what "reusable" means for that sum:

- Gross re-burn counts **every** succeeded run's recorded spend, `binary` and `prompt`, because reuse is
  not determinism-gated (finding 2). #144 does not discount the LLM leaves on the theory that "they'd
  have to re-run anyway"; under this rule they would not.
- The sum is over succeeded **leaf** prompt runs for the money (cost/usage are leaf-only, §5.7), which
  is the per-run unit finding 4 fixes, not a subtree-level estimate.
- The kills land with **unchanged inputs** (the reference run and the kills run the same pipeline over
  the same `commit_range`, [bar §2](resume-door-bar.md)), so the whole succeeded subtree at each kill is
  reusable, the collapsed form of finding 4. #144 need not model input-change; that is
  [#146](https://github.com/howardyang2009/PATH/issues/146)'s world, not the kill-run's.

## Forward dependencies recorded, not annexed

- **Session pooling (§5.5).** Finding 3 holds only while no-session-reuse holds. Recorded here; owned by
  whoever revisits §5.5.
- **The input-equality predicate.** Finding 4 delegates *how* to decide an input still holds to
  [#146](https://github.com/howardyang2009/PATH/issues/146), including whether a workflow-file
  fingerprint is needed.
- **A re-run of a half-landed run.** Reuse concerns succeeded runs. What a cause-blind re-run owes a step
  that already had an external effect is [#147](https://github.com/howardyang2009/PATH/issues/147)'s.
