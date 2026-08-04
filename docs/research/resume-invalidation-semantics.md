# Resume door — what invalidates a succeeded run's reuse?

The decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#146](https://github.com/howardyang2009/PATH/issues/146): given that
[#145](https://github.com/howardyang2009/PATH/issues/145) settled a succeeded run's recorded
output is reusable at all, and that [#142](https://github.com/howardyang2009/PATH/issues/142)
locks that inputs may change between attempts (fresh `--config`/`--set`, a re-read workflow
file) — what makes a recorded success **stop** counting?

## The rule

> A resumed run reuses the recorded output of every run whose status is `succeeded`, matched by
> node **id** in the re-read workflow file — regardless of whether config, the step's own
> definition (prompt/command/worker/inline config), or anything else about that node has changed
> since it ran. Every run whose status is `pending`, `cancelled`, or `failed` reruns, with fresh
> `--config`/`--set` and the re-read file. An operator who wants an already-`succeeded` run to
> redo does not get that from `resume` — they use the separate full-restart verb (a fresh
> `path run`, a new root run, discarding everything), not `resume`.

Reuse's key is **`(node id, status)`**, not `(node id, input object)`. Nothing about a
`succeeded` run is ever recomputed or compared; the status alone gates reuse. See
[Supersedes #145 finding 4](#supersedes-145-finding-4) below — this is a deliberate narrowing of
what [#145](https://github.com/howardyang2009/PATH/issues/145) committed to, not an
independent rule arrived at in ignorance of it.

## Why the rule is sound

Six findings, addressing the six candidate invalidators [#146](https://github.com/howardyang2009/PATH/issues/146)
named.

### 1. Cascading invalidation (changed input object) is a non-issue by construction

[mvp-spec §5.1](../spec/mvp-spec.md): a workflow body executes **strictly sequentially** — the
engine walks nodes one at a time, in order, within each thread (the top-level body, or one
`parallel` branch, or one `while-do`'s iteration chain). Grilling this ticket settled that the
**frontier — the first not-`succeeded` run — is per-thread**, not global: a `parallel` block's
branches run concurrently and a sibling-failed cancellation (CONTEXT.md's Cancellation entry)
can leave one branch fully `succeeded`, another `failed` partway, another `cancelled` before it
started, all under one block.

Within any one thread, execution order **is** causal order: a node can only start after its
predecessor in that thread finished. So a `succeeded` run can never sit downstream, in its own
thread, of a run that still needs rerunning — if the predecessor had needed rerun, the successor
would never have reached `succeeded` in the first place. There is therefore no live case of a
`succeeded` run's *actual* upstream output having changed out from under it. Cascading
invalidation needs no detection mechanism because the situation it would detect cannot occur.

### 2. Config reaching an already-succeeded run does not invalidate it

Resolves the "changed config reaching that run" bullet. Not "follows the value" and not "follows
the declaration" — reuse for a `succeeded` run does not consult config at all, changed or not.
This trades away a correctness property [#145](https://github.com/howardyang2009/PATH/issues/145)'s
finding 4 assumed (a reused output always answers the workflow's *current* input) for
predictability, and it reads truer to [#142](https://github.com/howardyang2009/PATH/issues/142)'s
own framing than the gated version did: *"fix the prompt, fix the expired token, **continue from**
step 14"* — continue *from*, not retroactively repair *before*. Steps that already succeeded
staying frozen is the design the phrase describes, not a gap in it.

### 3. A changed step body does not invalidate its recorded run either

Resolves "changed step body." Same reasoning as finding 2 — a `succeeded` run's reuse doesn't
distinguish *where* a change came from (CLI flag, root config file, or a hand-edit to the node's
own `prompt`/`command`/`worker`/inline `config` in the workflow file); it doesn't look at any of
it. This explicitly **overturns [#146](https://github.com/howardyang2009/PATH/issues/146)'s own
opening framing**, which called a changed step body "obviously invalid" — worth stating plainly
since it reverses the ticket's starting assumption rather than confirming it.

### 4. Tree-shape changes are resolved for free by id-based matching

Resolves "changed tree shape." [workflow-format-v0.md §3](../format/workflow-format-v0.md): every
body node carries a required `id`, unique across the whole file; there is no positional identity.
Reuse looks up a run by `(node id, succeeded)` in the prior root run's tree against the re-read
file: a renamed or removed node id has no match and runs fresh; an added node id has no match and
runs fresh; reordering an existing id changes nothing about the lookup. No new rule was needed —
id-based matching, already the format's design, already resolves this.

### 5. Staleness with nothing changed is out of scope

Resolves "nothing changed, but time passed." A reused run does not execute, so it cannot observe
its own staleness (a gone temp dir, a moved branch, an API's new state) at reuse time. A
downstream *fresh* run that depends on a stale value read from a reused output is a known,
accepted limitation of this rule, not something it detects or guards against.

### 6. Who decides: the engine, mechanically, on one field

Resolves "who decides." The engine checks exactly one thing — a prior run's `status` — no
declarative per-step "always re-run" marker, no operator-level per-step choice. The only
operator-level lever is choosing between the two verbs: `resume` (reuse-by-status, rerun the
rest) or a fresh `path run` (discard everything, start over). A declarative marker remains
nameable for a future map if a real need surfaces; it is not needed to close this ticket.

## Supersedes #145 finding 4

[#145](https://github.com/howardyang2009/PATH/issues/145) (PR
[#152](https://github.com/howardyang2009/PATH/pull/152), merged, closed) commits: *"the unit is
the **run**, keyed on `(node, input object)`"* — an equality gate, computed by comparing a
freshly-recomputed input object against the recorded one, explicitly delegated to this ticket
("Computing 'still holds' is #146's job"). This ticket **narrows that key to `(node id,
status)`**, dropping the input-object comparison entirely. #145's delegation anticipated this
ticket would define *how* "still holds" is computed; defining it as "trivially, by status alone,
because config/body changes are never checked against an already-succeeded run" is a valid — if
maximally simple — answer to that delegation, not a contradiction of #145's own scope.

Everything else in #145's finding 4 stands unchanged: the unit is the run (not something finer or
coarser); per-subtree reuse is still the collapsed form a whole `succeeded` workflow-run's output
gives for free; findings 1–3 and 5 of #145 (output-as-product, nondeterminism cutting toward
reuse, the dead-session argument, the counterfactual proving broad reuse is load-bearing) are
untouched — none of them depended on the equality gate this ticket removes.

**No retroactive effect on [#144](https://github.com/howardyang2009/PATH/issues/144)'s measured
residual** (PR #153): the kill-run's reference and kill attempts run the same pipeline over the
same `commit_range` with unchanged inputs throughout ([bar §2](resume-door-bar.md)), so a gated
vs. ungated reuse rule agrees on every run in that measurement. The number stands.

## Forward dependencies recorded, not annexed

- **[#147](https://github.com/howardyang2009/PATH/issues/147) (half-landed re-run)** is
  unaffected — it concerns what a rerun (not-`succeeded`) run owes an at-least-once world, which
  this ticket doesn't touch.
- **The CLI/format/API surface** — naming and building the two verbs this ticket assumes exist
  (`resume`, and a plain fresh `path run` as the "redo a succeeded step" escape hatch) is the next
  map's destination, per [#142](https://github.com/howardyang2009/PATH/issues/142)'s "not yet
  specified" list. This ticket only establishes that two verbs, not one, are needed, and what each
  one owes reuse.
- **A declarative "always re-run" marker** — named as a possible future need in finding 6, not
  designed here. Would be a format change, which per #142 this map cannot make.
