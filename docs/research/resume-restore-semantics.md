# Resume door — what a resumed tree restores, and what it re-creates

This is the decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#148](https://github.com/howardyang2009/PATH/issues/148).
[#145](https://github.com/howardyang2009/PATH/issues/145)/[#146](https://github.com/howardyang2009/PATH/issues/146)
settled *that* and *which* succeeded runs' `output.json` a resume may reuse, and
[#147](https://github.com/howardyang2009/PATH/issues/147) settled what a rerun owes the world. The
question: what does a resumed tree actually need to get its hands on, and by what mechanism, for the
reused runs' outputs to be usable at all?

This ticket also fixes [#149](https://github.com/howardyang2009/PATH/issues/149)'s central question as a
side effect of a answer to its own. Log-backend re-creation (`§8.2`, "instantiated per root run") only
has one coherent answer once run identity is settled, and a grilling of this ticket settled run identity
to answer it. **#149 still owns that finding formally.** This document states it because §148's own
answers depend on it, and it flags it for #149 to ratify rather than silently annex it.

## The rule

> A resumed tree is a **successor run**: a fresh root run id, its own `.path/runs/<new-root>/`
> directory, its own db rows, its own log backend instance. The original tree is never mutated,
> appended to, or reopened. It becomes permanent and read-only the moment the resumed tree starts,
> exactly as it was left (lying `running` rows included). Everything the resumed tree needs from the
> original tree is **read once at the point of reuse, never copied and never re-derived**:
>
> - A reused run's **output object** (`output.json`), settled by #145/#146.
> - A resumed workflow-run's **context blackboard**, its own `context.json`, read verbatim and used as
>   the starting in-memory context, then immediately written as a fresh, self-sufficient `context.json`
>   under the new tree (§6's existing seed-on-start rule, unchanged in behavior, just fed a different
>   seed source).
> - A reused run's **usage/cost figures**, not copied into the new tree's rows. A whole-tree cost query
>   for the resumed tree must traverse into the original tree via the reuse-marker link (below) for
>   every reused node. This amends §5.7's "read-time SUM over descendants" to cross root-run boundaries
>   wherever a reuse link exists, a spec change for #150 to land if the door opens, not made here.
>
> Everything else is **re-created**, never restored: processors (already true under §5.5, resume
> changes nothing), the log backend itself (a fresh instance under the new root run id), and the log
> narrative for anything not reused (ordinary fresh `step-started`/`step-finished`). For anything that
> *was* reused, the resumed tree's log carries a new **reuse-marker** event, not silence, that names the
> node, the original run it points at, and its own real timestamp. The marker's exact schema is
> next-map surface design, but its existence and its back-reference are decided here. Original run rows
> keep their true original timestamps. Nothing is ever rewritten to look like it just happened.

## Why the rule is sound

### 1. Restore-by-load, not recreate-by-replay, for context

A resumed workflow-run's blackboard could in principle be rebuilt two ways: load `context.json`
verbatim, or walk the reused children in order and re-apply each one's `publish` mapping against its
recorded `output.json`. These are not two designs with different results; they are the same result
reached two ways, because of how `context.json` was produced in the first place.
`persisted-observer.ts`'s `context-changed` handler
(`packages/engine/src/persistence/persisted-observer.ts:92-95`) rewrites the **whole** context object on
every mutation, not a diff. `run-workflow.ts` mutates one in-memory `context` bag with `Object.assign`
and emits the full bag each time (`packages/engine/src/run-workflow.ts:241,321,924,1054`). So a
workflow-run's `context.json`, at any point in its life, already **is** the accumulated result of every
completed publish up to that point. To replay publishes from output objects would recompute the
identical bytes through a slower path. Restore-by-load is the correct answer, because there is no
daylight between the two candidates to choose between; load is simply cheaper.

### 2. The restore applies to every non-succeeded workflow-run, not just the root

Invariant 4 (CONTEXT.md), a nested workflow-run starts with a fresh, empty context, describes a
workflow-run's *first* attempt. To resume an already-started, not-yet-succeeded workflow-run is not a
first attempt, and to treat it as one would re-enter that workflow-run from scratch, and re-run every
already-succeeded child inside it, exactly the cost reuse exists to avoid, and exactly where the
kill-run artifact's own kills landed. Both Kill B and Kill C
([resume-door-observations.md §3–4](resume-door-observations.md)) show this concretely: the iteration-2
**nested workflow-run** (`c34d2d2b.../` in Kill B, `74d52bfa.../` in Kill C) has its own `context.json`
on disk, distinct from the root's, that holds whatever that nested run's own succeeded children had
already published before the kill. If resume restored only the root's context and re-entered every
nested workflow-run fresh, the nested run's `revise` (iteration 1), already `succeeded` in both trees,
would be silently re-run despite #146's rule saying it should not be. The restore therefore recurses:
every workflow-run in the tree whose own status is not `succeeded` gets its own `context.json` restored
the same way.

### 3. Forced-exit truthfulness is a property of the write path, not the kill

`blob-store.ts`'s `writeBlobFile` (`packages/engine/src/persistence/blob-store.ts:11-17`) writes to a
temp file and `renameSync`s it into place. A same-filesystem rename is atomic, so a reader (or a crash)
never observes a partially written blob. This makes "is a forced-exit `context.json` truthful" not a
question the kill-run artifact needed to gamble on: it is guaranteed by construction, for every kill
shape, clean or forced. The artifact confirms it empirically rather than a need to discover it. Kill C's
root and nested-workflow-run `context.json` files are both present, complete, and un-torn despite
`forceExit(130)` bypassing the graceful unwind
([resume-door-observations.md §4](resume-door-observations.md)). No decision was needed here; this
finding states a fact the code already guarantees.

### 4. Run identity: successor run, settled here because §148 cannot proceed without it

§148's other findings (a fresh log backend, a cost query that must reach into another tree, a
reuse-marker event that must *point at* something) all presuppose an answer to "is a resumed tree the
same root run mutated in place, or a new one?" A grilling of this ticket settled it: **successor run**.
A fresh root run id. The original tree's rows, blobs, and log become permanent and read-only from the
moment resume starts, including its lying `running` rows (§5.6's admitted hole: nothing reconciles them,
and this ticket does not change that). Nothing is appended to the old ndjson file or old db rows. The
new tree's log backend is instantiated fresh, exactly as §8.2 already describes for any root run. Resume
does not need a new rule here, just confirmation that a resumed tree *is* a root run in that sense, a new
one.

This is [#149](https://github.com/howardyang2009/PATH/issues/149)'s question to own and formalize (its
blast-radius framing, `path runs` that shows two rows and a relationship, every surface that assumed
"one root run per attempt" inheriting a new concept, is exactly the consequence of this answer). It is
recorded here, not annexed, because #148's own findings do not hold under the alternative
(same-root-mutated) model without a re-derivation of all of them differently.

### 5. Usage/cost travel by reference, not by copy — an explicit amendment to §5.7

§5.7 states subtree/whole-run cost as a read-time SUM over descendant run rows, so "ground truth exists
exactly once." Under the successor-run model, a reused node's usage/`estimated_cost_usd` row lives only
in the *original* tree; the new tree's own descendant rows do not include it. Left unaddressed, a cost
query over the resumed tree would silently undercount every reused LLM run, which is exactly backwards
for a feature whose "every token this door saves is saved by trusting a recorded success"
([#142](https://github.com/howardyang2009/PATH/issues/142)) already puts the reused LLM spend at the
center of the accounting. Consistent with finding 4's reference-not-copy principle, the fix is not to
duplicate rows (which would create two ground truths for the same spend, the exact failure mode §5.7 was
written to prevent) but to have the SUM traverse the reuse-marker link into the original tree for every
reused node. This is a real, stated change to §5.7's semantics. To land it in the spec text is
[#150](https://github.com/howardyang2009/PATH/issues/150)'s job if the door opens, not this ticket's.

### 6. §8.1's "complete narrative" promise needs a reuse-marker event, not silence

§8.1: "the log alone reads as the complete chronological story of a run tree." A resumed tree that
reuses a whole succeeded subtree emits no `step-started`/`step-finished` for any node in it. Under
silence, the resumed tree's own log has a gap exactly where the reused subtree is, and the only place
that story exists is the *original* tree's log, a different file entirely. That is a real break of §8.1
for the resumed tree considered on its own, not a cosmetic omission: a reader handed only the new tree's
log cannot reconstruct what happened. The fix is a new log-event category (name deferred to whoever
designs the next map's surface) that fires once per reused node and carries at minimum a back-reference
(the original run's id, sufficient to locate its log), so a reader can follow the pointer rather than hit
a silent gap. The event's own timestamp is the ordinary log envelope's `ts` (§8.1); no separate
"resume-time" timestamp concept is needed for it.

### 7. The lying `running` rows need no correction before a resumed tree can be read

Under [#146](https://github.com/howardyang2009/PATH/issues/146)'s rule, reuse gates on exactly one
check: is this node's status `succeeded`? `running` fails that check identically to `failed` or
`cancelled`. There is no special case to add, and no reconciliation pass is a precondition for resume to
work correctly. The row's permanent `running` reading is a separate, already-acknowledged problem
([resume-door-bar.md §1](resume-door-bar.md): "this door does not own it"; a startup reconcile pass
would close it with no resume semantics at all), and it stays orthogonal to whether resume itself
functions. Confirmed against the artifact: Kill C's three `running` rows (`resume-door-observations.md
§4`) are exactly the rows a resumed tree would re-run. The mechanism needs nothing more from them than
their status.

### 8. Processors and step-owned temp state need no new decision

Processors are already fresh-per-run in ordinary execution (§5.5, no session reuse in MVP). Resume
introduces nothing new here; a resumed run's processors are exactly as fresh as any run's always are.
Any state a step assumed it owned outside PATH's own records (a temp dir, an external side effect) is
[#147](https://github.com/howardyang2009/PATH/issues/147)'s territory already: at-least-once, author's
idempotence burden, uniformly across `binary` and `prompt`. Nothing about restore/re-create changes that
finding; it is cited here rather than re-derived.

## Forward dependencies recorded, not annexed

- **[#149](https://github.com/howardyang2009/PATH/issues/149)** owns the formalize of the successor-run
  identity model this ticket assumes (finding 4), including the operator-facing consequences (`path
  runs` that shows a relationship between two trees) that are genuinely its scope, not this one's.
- **The reuse-marker event's exact schema** (field names, where it sits in the discriminated union) is
  surface design for the next map, per [#142](https://github.com/howardyang2009/PATH/issues/142)'s own
  fence against this map building the resume surface. This ticket fixes only that the event must exist
  and must carry a back-reference.
- **§5.7's cross-tree SUM amendment** and **§1/§5.6/§10's rewrite** are
  [#150](https://github.com/howardyang2009/PATH/issues/150)'s to land in the spec text, contingent on the
  door opening at all.
- **No CONTEXT.md edit**, matching #145/#146/#147's precedent: no `resume` glossary term until the
  CLI/format surface lands ([#142](https://github.com/howardyang2009/PATH/issues/142)'s "not yet
  specified" list).
