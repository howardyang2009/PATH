# Resume door — what invalidates a succeeded run's reuse?

This is the decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#146](https://github.com/howardyang2009/PATH/issues/146). [#145](https://github.com/howardyang2009/PATH/issues/145)
settled that a succeeded run's recorded output is reusable at all, and
[#142](https://github.com/howardyang2009/PATH/issues/142) locks that inputs may change between attempts
(fresh `--config`/`--set`, a re-read workflow file). The question: what makes a recorded success
**stop** counting?

## The rule

> A resumed run reuses the recorded output of every run whose status is `succeeded`, matched by node
> **id** in the re-read workflow file, regardless of whether config, the step's own definition
> (prompt/command/worker/inline config), or anything else about that node has changed since it ran.
> Every run whose status is `pending`, `cancelled`, or `failed` reruns, with fresh `--config`/`--set`
> and the re-read file. An operator who wants an already-`succeeded` run to redo does not get that from
> `resume`. They use the separate full-restart verb (a fresh `path run`, a new root run, which discards
> everything), not `resume`.

Reuse's key is **`(node id, status)`**, not `(node id, input object)`. Nothing about a `succeeded` run
is ever recomputed or compared; the status alone gates reuse. See
[Supersedes #145 finding 4](#supersedes-145-finding-4) below. This is a deliberate narrowing of what
[#145](https://github.com/howardyang2009/PATH/issues/145) committed to, not an independent rule arrived
at in ignorance of it.

## Why the rule is sound

Six findings, which address the six candidate invalidators
[#146](https://github.com/howardyang2009/PATH/issues/146) named.

### 1. Cascading invalidation (changed input object) is a non-issue by construction

[mvp-spec §5.1](../spec/mvp-spec.md): a workflow body executes **strictly sequentially**. The engine
walks nodes one at a time, in order, within each thread (the top-level body, or one `parallel` branch,
or one `while-do`'s iteration chain). A grilling of this ticket settled that the **frontier, the first
not-`succeeded` run, is per-thread**, not global. A `parallel` block's branches run concurrently, and a
sibling-failed cancellation (CONTEXT.md's Cancellation entry) can leave one branch fully `succeeded`,
another `failed` partway, and another `cancelled` before it started, all under one block.

Within any one thread, execution order **is** causal order: a node can only start after its predecessor
in that thread finished. So a `succeeded` run can never sit downstream, in its own thread, of a run that
still needs a rerun. If the predecessor had needed a rerun, the successor would never have reached
`succeeded` in the first place. There is therefore no live case of a `succeeded` run's *actual* upstream
output having changed out from under it. Cascading invalidation needs no detection mechanism, because
the situation it would detect cannot occur.

### 2. Config reaching an already-succeeded run does not invalidate it

This resolves the "changed config reaching that run" bullet. It is not "follows the value" and not
"follows the declaration": reuse for a `succeeded` run does not consult config at all, changed or not.
This trades away a correctness property [#145](https://github.com/howardyang2009/PATH/issues/145)'s
finding 4 assumed (a reused output always answers the workflow's *current* input) for predictability. It
reads truer to [#142](https://github.com/howardyang2009/PATH/issues/142)'s own framing than the gated
version did: *"fix the prompt, fix the expired token, **continue from** step 14"* — continue *from*, not
retroactively repair *before*. Steps that already succeeded staying frozen is the design the phrase
describes, not a gap in it.

### 3. A changed step body does not invalidate its recorded run either

This resolves "changed step body." The reasoning is the same as finding 2: a `succeeded` run's reuse
does not distinguish *where* a change came from (CLI flag, root config file, or a hand-edit to the
node's own `prompt`/`command`/`worker`/inline `config` in the workflow file); it does not look at any of
it. This explicitly **overturns [#146](https://github.com/howardyang2009/PATH/issues/146)'s own opening
framing**, which called a changed step body "obviously invalid." Worth stating plainly, because it
reverses the ticket's starting assumption rather than confirm it.

### 4. Tree-shape changes are resolved for free by id-based matching

This resolves "changed tree shape." [workflow-format-v0.md §3](../format/workflow-format-v0.md): every
body node carries a required `id`, unique across the whole file; there is no positional identity. Reuse
looks up a run by `(node id, succeeded)` in the prior root run's tree against the re-read file. A renamed
or removed node id has no match and runs fresh. An added node id has no match and runs fresh. A reorder
of an existing id changes nothing about the lookup. No new rule was needed: id-based matching, already
the format's design, already resolves this.

### 5. Staleness with nothing changed is out of scope

This resolves "nothing changed, but time passed." A reused run does not execute, so it cannot observe
its own staleness (a gone temp dir, a moved branch, an API's new state) at reuse time. A downstream
*fresh* run that depends on a stale value read from a reused output is a known, accepted limitation of
this rule, not something it detects or guards against.

### 6. Who decides: the engine, mechanically, on one field

This resolves "who decides." The engine checks exactly one thing, a prior run's `status`: no declarative
per-step "always re-run" marker, no operator-level per-step choice. The only operator-level lever is the
choice between the two verbs: `resume` (reuse-by-status, rerun the rest) or a fresh `path run` (discard
everything, start over). A declarative marker remains nameable for a future map if a real need surfaces.
It is not needed to close this ticket.

## Supersedes #145 finding 4

[#145](https://github.com/howardyang2009/PATH/issues/145) (PR
[#152](https://github.com/howardyang2009/PATH/pull/152), merged, closed) commits: *"the unit is the
**run**, keyed on `(node, input object)`"*, an equality gate, computed by a comparison of a
freshly-recomputed input object against the recorded one, explicitly delegated to this ticket ("Computing
'still holds' is #146's job"). This ticket **narrows that key to `(node id, status)`**, and drops the
input-object comparison entirely. #145's delegation anticipated this ticket would define *how* "still
holds" is computed. To define it as "trivially, by status alone, because config/body changes are never
checked against an already-succeeded run" is a valid answer to that delegation, if a maximally simple
one, not a contradiction of #145's own scope.

Everything else in #145's finding 4 stands unchanged: the unit is the run (not something finer or
coarser); per-subtree reuse is still the collapsed form a whole `succeeded` workflow-run's output gives
for free; findings 1 to 3 and 5 of #145 (output-as-product, nondeterminism cutting toward reuse, the
dead-session argument, the counterfactual that proves broad reuse is load-bearing) are untouched, none
of them depended on the equality gate this ticket removes.

**No retroactive effect on [#144](https://github.com/howardyang2009/PATH/issues/144)'s measured
residual** (PR #153): the kill-run's reference and kill attempts run the same pipeline over the same
`commit_range` with unchanged inputs throughout ([bar §2](resume-door-bar.md)), so a gated vs. ungated
reuse rule agrees on every run in that measurement. The number stands.

## Forward dependencies recorded, not annexed

- **[#147](https://github.com/howardyang2009/PATH/issues/147) (half-landed re-run)** is unaffected. It
  concerns what a rerun (not-`succeeded`) run owes an at-least-once world, which this ticket does not
  touch.
- **The CLI/format/API surface.** To name and build the two verbs this ticket assumes exist (`resume`,
  and a plain fresh `path run` as the "redo a succeeded step" escape hatch) is the next map's
  destination, per [#142](https://github.com/howardyang2009/PATH/issues/142)'s "not yet specified" list.
  This ticket only establishes that two verbs, not one, are needed, and what each one owes reuse.
- **A declarative "always re-run" marker.** Named as a possible future need in finding 6, not designed
  here. It would be a format change, which per #142 this map cannot make.
