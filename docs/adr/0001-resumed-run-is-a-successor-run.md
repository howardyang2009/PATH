# Resumed runs are successor runs, not the same root run mutated in place

Status: accepted

Resuming a tree ([#142](https://github.com/howardyang2009/PATH/issues/142) map,
[#149](https://github.com/howardyang2009/PATH/issues/149)) creates a **fresh root run id** — its own
db rows, its own `.path/runs/<root-run-id>/` directory, its own log backend instance. The original
tree becomes permanent and read-only the instant resume starts (lying `running` rows included) and
is never mutated, appended to, or reopened. Everything the new tree needs from the original — a
reused node's `output.json`, a resumed workflow-run's `context.json`, usage/cost figures — is read
once at the point of reuse and referenced going forward (via a **reuse-marker** log event on the new
tree, carrying a back-reference to the original run), never copied and never re-derived.

## Considered Options

- **Same root run id, rows mutate in place.** Cheaper to explain ("the run continued"), one row per
  execution attempt stays true. Rejected: `seq` is documented as monotonic per root run — the
  ordering truth (`CONTEXT.md` §8, log event envelope) — and a second pass appending
  `step-started`/`step-finished` for a node that already finished in the first pass produces a log
  narrative with no coherent reading. No fix preserves the ordering contract without changing what
  `seq` means.
- **Successor run, linked to the original.** Chosen. Costs the "one root run per execution attempt"
  simplicity — every surface that assumed it (run rows, blob directories, `GET /v0/runs`, the
  viewer, `path runs`) now has to render a relationship between two trees instead of one row. Every
  one of #148's findings (fresh log backend per §8.2, a cost query that must reach into another
  tree, a reuse-marker event that must point at something) falls out cleanly under this model and
  does not hold under the alternative without re-deriving them differently.

## Consequences

- Two relationships exist and can name different trees for the same resume, and are kept separate
  rather than collapsed into one: **resumed-from** (tree-level, root-run row, always the immediate
  predecessor — records what command was actually run) vs. the **reuse-marker** (node-level, log
  event, direct-to-source — records where a node's real data lives, skipping past any predecessor
  tree that never touched that node). A three-deep resume chain can have R3 "resumed-from" R2 while
  R3's reuse-marker for a given node points straight at R1.
- `path runs rm <root-run-id>` must check, before deleting, whether any still-live tree holds a
  reuse-marker back-referencing a run inside the tree being deleted, and refuse (or require an
  explicit force/prune) if so — otherwise §6's "the two stores never drift" guarantee is replaced by
  a silent dangling pointer and an undercounted cost query. The check is read-only against the
  existing global `runs`/`log` tables (§6: one `path.db` per project, not per tree) — the original
  tree is never written to. This requires the reuse-marker's back-reference to be cheaply resolvable
  to a root run id (not just a leaf run id); the exact field shape is deferred to whoever designs the
  reuse-marker's schema, but the requirement is fixed here.
- `CONTEXT.md` gains a **Resume** section (`root run`, `successor run`, `resumed-from`,
  `reuse-marker`) despite #145/#146/#147/#148's precedent of holding `resume` vocabulary until the
  CLI/format surface lands — the identity model itself, not just its spelling, was judged
  glossary-worthy now.
