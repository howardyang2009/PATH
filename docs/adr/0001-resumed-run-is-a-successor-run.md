# Resumed runs are successor runs, not the same root run mutated in place

Status: accepted

To resume a tree ([#142](https://github.com/howardyang2009/PATH/issues/142) map,
[#149](https://github.com/howardyang2009/PATH/issues/149)) creates a **fresh root run id**. It has its
own db rows, its own `.path/runs/<root-run-id>/` directory, and its own log backend instance. The
original tree becomes permanent and read-only the instant resume starts (lying `running` rows
included). The engine never mutates, appends to, or reopens it. Everything the new tree needs from the
original (a reused node's `output.json`, a resumed workflow-run's `context.json`, usage and cost
figures) is read once at the point of reuse and referenced from then on. A **reuse-marker** log event
on the new tree carries a back-reference to the original run. Nothing is copied, and nothing is
re-derived.

## Considered Options

- **Same root run id, rows mutate in place.** It is cheaper to explain ("the run continued"), and one
  row per execution attempt stays true. Rejected: `seq` is documented as monotonic per root run, the
  ordering truth (`CONTEXT.md` §8, log event envelope). A second pass that appends `step-started` and
  `step-finished` for a node that already finished in the first pass produces a log narrative with no
  coherent reading. No fix preserves the ordering contract without a change to what `seq` means.
- **Successor run, linked to the original.** Chosen. It costs the "one root run per execution attempt"
  simplicity. Every surface that assumed it (run rows, blob directories, `GET /v0/runs`, the viewer,
  `path runs`) now has to render a relationship between two trees instead of one row. Every one of
  #148's findings (a fresh log backend per §8.2, a cost query that must reach into another tree, a
  reuse-marker event that must point at something) falls out cleanly under this model. It does not hold
  under the alternative without re-deriving them differently.

## Consequences

- Two relationships exist. They can name different trees for the same resume, and they are kept
  separate rather than collapsed into one. **resumed-from** is tree-level, on the root-run row, always
  the immediate predecessor; it records what command was actually run. The **reuse-marker** is
  node-level, a log event, direct-to-source; it records where a node's real data lives, and skips past
  any predecessor tree that never touched that node. A three-deep resume chain can have R3 "resumed-from"
  R2 while R3's reuse-marker for a given node points straight at R1.
- `path runs rm <root-run-id>` must check, before it deletes, whether any still-live tree holds a
  reuse-marker that back-references a run inside the tree being deleted. It must refuse (or require an
  explicit force/prune) if so. Otherwise §6's "the two stores never drift" guarantee is replaced by a
  silent dangling pointer and an undercounted cost query. The check is read-only against the existing
  global `runs` and `log` tables (§6: one `path.db` per project, not per tree); the original tree is
  never written to. This requires the reuse-marker's back-reference to be cheaply resolvable to a root
  run id, not just a leaf run id. The exact field shape is deferred to whoever designs the
  reuse-marker's schema, but the requirement is fixed here.
- `CONTEXT.md` gains a **Resume** section (`root run`, `successor run`, `resumed-from`,
  `reuse-marker`). This is despite the #145/#146/#147/#148 precedent of holding `resume` vocabulary
  until the CLI/format surface lands. The identity model itself, not just its spelling, was judged
  glossary-worthy now.
