# Resume door — run identity: successor run, formally ratified

The decision fixed by [map #142](https://github.com/howardyang2009/PATH/issues/142) ticket
[#149](https://github.com/howardyang2009/PATH/issues/149): given that
[#148](https://github.com/howardyang2009/PATH/issues/148) needed a working answer to "is a resumed
run the same root run mutated, or a successor?" to finish its own scope — and flagged that answer
here rather than silently annexing it — this ticket owns the question formally: ratify, adjust, or
override the pick, and own the operator-facing consequences that follow from it.

## The rule

> A resumed tree is a **successor run**: a fresh root run id, its own `.path/runs/<new-root>/`
> directory, its own db rows, its own log backend instance. The original tree is never mutated,
> appended to, or reopened — it becomes permanent and read-only the moment the resumed tree starts,
> exactly as it was left (lying `running` rows included). Everything the resumed tree needs from the
> original tree is read once at the point of reuse and referenced going forward, never copied.
>
> Two distinct relationships exist, and are kept separate rather than collapsed into one:
>
> - **Resumed-from** — a tree-level fact, recorded on the successor's own root-run row: always the
>   *immediate* predecessor, one hop, regardless of how far back the data it actually reuses lives.
>   It records what command the operator ran, not where the data is.
> - **Reuse-marker** — a node-level log event on the successor's stream (already required by #148,
>   finding 6), naming, for one reused node, the original run holding that node's real data:
>   **direct-to-source**, skipping any predecessor tree that never held that node.
>
> These can name different trees for the same resume. A three-deep chain — root run R1 fails,
> resumed as R2, R2 also fails/killed, resumed as R3 — has R3 "resumed-from" R2 unconditionally, while
> R3's reuse-marker for a node R2 never touched points straight at R1, not through R2.
>
> `path runs rm <root-run-id>` must check, before deleting, whether any still-live tree holds a
> reuse-marker back-referencing a run inside the tree being deleted, and refuse by default (an
> explicit force/prune is the escape hatch). The check is read-only: `.path/path.db` is one file per
> *project*, not per tree (§6) — its `runs` and `log` tables already hold rows for every root run, so
> the check is a query over existing data, and the tree being deleted is never written to. This
> requires a reuse-marker's back-reference to be cheaply resolvable to a root run id, not just a leaf
> run id — stated here as a hard requirement; the exact field shape is deferred to whoever specs the
> reuse-marker event, per #148's existing deferral.
>
> `path runs` after three resumes shows three rows, not a merged or collapsed one — each root run
> keeps its own identity, status, and timestamps:
>
> ```
> ROOT RUN   STATUS      RESUMED FROM
> R1         failed      —
> R2         cancelled   R1
> R3         succeeded   R2
> ```

## Why the rule is sound

### 1. Same-root mutation breaks the ordering contract; successor run doesn't

`seq` is documented as monotonic per root run — "the ordering truth" (`CONTEXT.md`, Audit § Log
event). A second pass appending `step-started`/`step-finished` for a node that already finished in
the first pass produces a log narrative in which the same step starts twice, with no coherent
reading — the ordering contract has no fix that preserves its meaning under that model. The
successor-run model doesn't have this problem: each root run's own `seq` stream stays a single,
uninterrupted narrative, because nothing is ever appended to a finished tree's stream.

### 2. #148's findings only cohere under this model, confirming rather than re-deciding

#148 already found: a fresh log backend per §8.2 ("instantiated per root run"), a cost query that
must reach into another tree (amending §5.7's read-time SUM), and a reuse-marker event that must
point at something. All three presuppose "a resumed tree is a new root run, distinct from the one it
resumed" — none of them holds under same-root-mutated without being re-derived differently, and none
needed re-deriving here. Ratifying successor run is confirming a model #148 already exercised, not
picking one cold.

### 3. Resumed-from and reuse-marker answer different questions and must be allowed to disagree

Forcing these into one link costs something on either side. Making the single link always
immediate-predecessor (chain-of-custody: R3→R2→R1) breaks the reuse-marker's single-hop guarantee —
a reader or a cost-SUM query would have to walk the chain to find a node R2 never actually held.
Making the single link always direct-to-source loses the fact that R2 was ever attempted at all — it
vanishes from `path runs`' history. Keeping them separate costs nothing: `resumed-from` answers "what
did the operator run," `reuse-marker` answers "where does this node's data live," and an operator
reading `path runs` after several resumes sees both facts without either one lying.

### 4. The `rm`-blocks-by-default rule preserves §6's no-drift guarantee under cross-tree references

§6 states run db rows and the run directory tree delete together, "so the two stores never drift."
Before this ticket, that was true unconditionally because a tree had no external readers. A
successor's reuse-marker and cost-SUM traversal (per #148, finding 5) now make a predecessor tree's
data reachable *from outside its own rows* — deleting it out from under a live successor would
produce exactly the silent lie (a dangling pointer, an undercounted subtree) the rest of this map has
refused everywhere else. Blocking by default keeps the no-drift guarantee true in the presence of
cross-tree references instead of quietly narrowing its scope to "true only for trees nothing else
points at."

### 5. The `rm` safety check needs no new table, because the db was already project-wide, not per-tree

§6: `.path/path.db` is one file "beside the workflow files (like `.git`)" — singular, holding the
**runs table** and the **log table** for every root run, each event stamped with the root run id
from `open()` (§8.2). Only `.path/runs/<root-run-id>/` (blobs) is per-tree. A successor's
reuse-marker event is therefore already a row in the same global log table the moment it's written,
just stamped with the successor's own root run id — no new structure is needed to hold the
relationship, and the predecessor tree is never touched to record that it was referenced: the
reference lives entirely on the referencer's side, which is where the "original tree is never
mutated, appended to, or reopened" rule already said it must live.

### 6. The identity model earns a glossary entry now, ahead of the CLI/format surface

#145/#146/#147/#148 all deferred `resume` vocabulary in `CONTEXT.md` until the CLI/format surface
lands (#142's fence against this map building the resume surface). That precedent covers *spelling*
— flag names, route shapes. It doesn't cover whether the *identity model* is a domain concept. It is:
`root run`, `successor run`, `resumed-from`, and `reuse-marker` are load-bearing distinctions an
engineer needs to reason correctly about run rows, `seq`, and the cost-SUM traversal, independent of
what the CLI ends up calling any of them. `CONTEXT.md` gains a `## Resume` section stating these four
terms; no CLI flag or HTTP route is named or implied by doing so.

## Forward dependencies recorded, not annexed

- **The reuse-marker event's exact schema** — field names, where it sits in the discriminated union,
  and specifically how its back-reference resolves to a root run id (finding 5 above) — remains
  surface design for the next map, per #142's fence. This ticket fixes only that the back-reference
  must exist and must be cheaply resolvable to a root run id.
- **`path runs`' exact column spellings and `rm`'s exact flag for the force/prune escape hatch** are
  likewise next-map surface design; this ticket fixes only the shape (three rows stay three rows, a
  `resumed-from` fact per row, `rm` blocks by default).
- **§5.7's cross-tree SUM amendment** and **§1/§5.6/§10's rewrite** remain #150's to land in the spec
  text, contingent on the door opening at all — unchanged from #148's note.
