# A Resume rerun boundary is a suppression set on the two reuse producers, not a new walker or a persisted plan

Status: accepted

Resume-from-chosen-K ([#428](https://github.com/howardyang2009/PATH/issues/428), the engine mechanism
of map [#427](https://github.com/howardyang2009/PATH/issues/427)) gives Resume a **rerun boundary K**:
nodes serialized before K reuse their succeeded results, K and every serialized-later top-level node
re-run entire in a fresh non-destructive successor (`CONTEXT.md` §Resume, **Rerun boundary (K)**). The
engine expresses that boundary as a **suppression set of run-producing node ids** consulted at exactly
the two places reuse fires — the `planReuse` short-circuit (`plan-reuse.ts:27-40`, consumed at
`run-workflow.ts:1168`) and the `findNestedCounterpart` re-entry (`plan-reuse.ts:59-67`, consumed at
`run-workflow.ts:461-465`). K enters as one field on `ResumeInput` (`run-workflow.ts:126-131`); the set
is derived once over the top-level slice `body.slice(indexOf(K))` with the exact walk `planReuse`
already uses (`walkNodes` over `RUN_PRODUCING_TYPES`, `plan-reuse.ts:33-34`); two one-line guards drop
its ids from reuse. There is no new node walker, no new persisted column, and no second code path. The
full mechanism map is [docs/research/resume-from-k-mechanism.md](../research/resume-from-k-mechanism.md);
[ADR 0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md) generalizes this root-only
set to the per-level chain that lets K sit inside a nested `workflow`.

## Considered Options

### How the engine expresses the boundary

- **A suppression set on the two reuse producers** (chosen). Reuse is a single lookup by
  `(scope, node_id)` + `succeeded` read at exactly two producers, and nothing else in the walk knows
  about resume (`docs/research/debug-plan-reuse-cursor.md`, restated `resume-from-k-mechanism.md` §head).
  So the boundary is expressible as a guard on those two producers and nowhere else: skip a ≥K id in
  `planReuse`, and refuse the counterpart for a ≥K `workflow` node so its whole subtree re-runs. The
  prefix (index < K) is never in the set, so it plans and reuses bit-for-bit as today.
- **An index range instead of an id set.** Rejected. An id set survives a rename or move of K by id
  (`CONTEXT.md` §Identity); an index range breaks the moment the current file reorders. The only cost of
  the set is one `findIndex` at build time.
- **A new resume-aware node walker.** Rejected as unnecessary. The predicate "node is ≥K" is precise
  for all three ≥K shapes using the walk `planReuse` already runs: a ≥K leaf contributes its own id; a
  ≥K logicer (`while-do`/`parallel`/`sequence`) owns no run row (invariant 1) but `walkNodes` descends
  it, so its run-producing descendants land in the set (subtree entire); a ≥K `workflow` node contributes
  only its own id (`walkNodes` never descends a ref, `plan-reuse.ts:19-21`) and its subtree is forced
  fresh by the counterpart-refusal guard. No second traversal earns its keep.
- **A persisted `rerun` column on the run row.** Rejected for correctness (kept, separately, as a read
  denormalization by [ADR 0032](0032-resume-from-k-boundary-representation-and-successor-provenance.md)).
  ≥K nodes write ordinary fresh `succeeded` rows and <K nodes write reuse rows (#257) exactly as plain
  Resume, so `RunRecord` needs no boundary field for the engine to run correctly.

## Consequences

- **Two guards are the whole change.** Producer A: `planReuse` takes an optional suppression set and
  skips a member id in its walk. Producer B: the descent site refuses the counterpart for a suppressed
  `workflow` node, so `runWorkflowNode` seeds it fresh from input and it re-runs its whole tree. No
  walker, no schema, no new route logic in this mechanism.
- **The set is root-only, so a nested id collision cannot misfire.** Node ids are unique only within one
  file (`plan-reuse.ts:15-18`). The caller builds the set only for the root run and a child's
  `params.resume` is rebuilt with `input` + `counterpart` only (`run-workflow.ts:458-467`), so
  `RunResume.rerunSet` is undefined for every non-root run — suppression stays root-only for free. This
  root-only reach is exactly the limit [ADR 0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md)
  lifts to reach a child's `planReuse` for nested-K.
- **Prefix loops and parallel keep today's behavior.** `runSequence`, `runWhileDoNode`
  (`run-workflow.ts:1088-1109`), and `runParallelNode` read reuse only through `plan.get(node.id)`
  (`run-workflow.ts:1168`) and the wait-one winner picker (`plan-reuse.ts:111-124`). A prefix id is
  never in the set, so the plan holds exactly the rows plain Resume builds. The multi-iteration-loop
  reuse limit (an id with more than one succeeded candidate does not reuse, `plan-reuse.ts:23-25`) is
  neither fixed nor worsened; it stays out of scope (map #427).
- **Plain Resume is the K = auto-boundary case, one code path.** An absent K seeds no set, so `planReuse`
  receives none, both guards are skipped, and `findNestedCounterpart` runs exactly as today — the
  existing resume path, byte for byte. And plain Resume *is* Resume-from-K at the auto-boundary: setting
  K to the first non-succeeded top-level node yields a set whose ids own no succeeded rows, so
  suppressing them changes nothing. Resume-from-K is therefore a strict superset that only ever
  suppresses reuse the operator explicitly asked to discard.
- **The claim rests on reuse firing at only two producers.** No running Resume-from-K engine exists yet
  (#427 is a map); this is a static reading of the two producers and their consumers. A future reuse
  consumer added elsewhere would need the same guard.
