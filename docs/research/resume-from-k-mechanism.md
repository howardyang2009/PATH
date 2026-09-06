# Resume-from-K: how the engine expresses a rerun boundary

Research ticket [howardyang2009/PATH#428]. Resolves the mechanism question left open by the
Resume-from-K map (#427). It asks: how should the engine express a **rerun-from-K** boundary so that
plan-reuse **reuses every succeeded node before K** and **force-reruns K plus every serialized-later
top-level node**?

Primary source: this codebase at `main` (commit `68bf4da`). All cites are `file:line`. Builds on the
prior plan-reuse research (`docs/research/debug-plan-reuse-cursor.md`) — that doc established the one
fact this recommendation rests on: **reuse is a single lookup by `(parent-run scope, node_id)` +
`succeeded`, read at exactly two places** (`plan-reuse.ts:35-37`, consumed at `run-workflow.ts:1168`
and `run-workflow.ts:461`). Nothing else in the walk knows about resume. That is why the boundary is
expressible as a guard on those two producers, and nowhere else.

Constraints locked by the map (#427), treated as fixed here: K is a **top-level sequence node**;
"≥K" = K's index in the top-level sequence and every higher index, each child subtree entire; nodes
before K reuse (reuse rows, direct-to-source); nodes ≥K re-run in a fresh non-destructive successor
tree; the source run stays read-only; prefix loops/parallel behave exactly as plain Resume today; the
known multi-iteration-loop reuse limitation is out of scope; Resume-from-K is a superset of plain
Resume (plain Resume = K at the auto-boundary).

## The current model in one paragraph

`Project.resume` reads the whole original tree's rows, swaps each reuse row for its source
(`project.ts:210-228`), and hands the engine a `ResumeInput = { originalRuns, readBlob }`
(`project.ts:243-246`; type at `run-workflow.ts:126-131`). `runWorkflow` finds the original root run
(`run-workflow.ts:720`) and passes it as the root run's counterpart (`run-workflow.ts:755`). Each
workflow-run then computes its **own** reuse plan over its own scope —
`planReuse(originalRuns, file, counterpart.runId)` (`run-workflow.ts:279`) — a `Map<node_id,
RunRecord>` of the succeeded direct children (`plan-reuse.ts:27-40`). Reuse then happens in exactly
two places: a run-producing node short-circuits when `run.resume.plan.get(node.id)` hits
(`run-workflow.ts:1168`, applied `1175-1178`); a non-reused `workflow` node **re-enters** its nested
counterpart via `findNestedCounterpart` (`run-workflow.ts:461-465`, `plan-reuse.ts:59-67`), and that
child run reuses its own succeeded grandchildren. Today reuse fires **everywhere** a node succeeded;
there is no boundary. Resume-from-K adds one.

## Recommendation: the smallest viable change

A rerun boundary is a **suppression set of run-producing node ids** applied to the root run's two
reuse producers. K enters as one string on the resume request; the set is derived once; two one-line
guards consult it. No new persisted column, no second code path, no change to any node walker.

### 1. How the boundary enters a run

Add one optional field to `ResumeInput` (`run-workflow.ts:126-131`):

```ts
export interface ResumeInput {
  originalRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /** K: the id of the top-level sequence node to force-rerun from. Undefined = plain Resume. */
  rerunFromNodeId?: string;
}
```

It is set by the one caller that builds `ResumeInput`, `Project.resume`, alongside `originalRuns`
and `readBlob` (`project.ts:243-246`). `Project.resume`'s signature (`project.ts:199-204`, contract
`project.ts:72`) takes a new optional `rerunFromNodeId` and threads it straight in. The value
originates one hop further out at the wire edge (the server route `ResumeBodySchema`,
`packages/server/src/routes/resume-run.ts:9-13`, and `path resume` in `cli.ts`) — see point 6; that
plumbing is #429's, not this ticket's. Inside the engine the field rides `ResumeInput` untouched
until the point of use.

### 2. How the rerun set is computed over the top-level sequence

The rerun set is **run-producing** node ids reachable from every top-level node at index ≥ index(K),
each child subtree entire. It is computed **once, for the root run only**, reusing the exact walk
`planReuse` already uses (`walkNodes` over `RUN_PRODUCING_TYPES`, `plan-reuse.ts:33-34`;
`walkNodes` exported from `@path/schema`, `node-walk.ts:120`):

```ts
function rerunSet(body: WorkflowNode[], k: string): Set<string> {
  const from = body.findIndex((n) => n.id === k);
  if (from < 0) return new Set();                       // K not a top-level node — reject upstream
  const ids = new Set<string>();
  for (const node of walkNodes(body.slice(from)))       // K and every serialized-later top-level node
    if (RUN_PRODUCING_TYPES.has(node.type)) ids.add(node.id);
  return ids;
}
```

The exact predicate for "node is ≥K": **its run-producing id appears in `rerunSet(file.body, K)`.**
This is precise for all three ≥K shapes:
- A ≥K **leaf** (`prompt`/`binary`): its own id is in the set.
- A ≥K **logicer** (`while-do`/`parallel`/`sequence`) has no run row of its own (CONTEXT invariant
  1, `CONTEXT.md:109-110`); `walkNodes` descends into it, so all its run-producing **descendant** ids
  land in the set — "child subtree taken entire."
- A ≥K **`workflow`** node: `walkNodes` never descends a `workflow` ref (`plan-reuse.ts:19-21`), so
  only the node's own id is in the set. Forcing its whole nested subtree fresh is handled by the
  re-entry guard in point 3.

### 3. How reuse is suppressed for ≥K without touching the prefix

Reuse originates at two producers; a ≥K id is refused at both, and only for the **root** scope.

**Producer A — `planReuse` (`plan-reuse.ts:27-40`).** Add an optional `rerunSet` parameter and one
guard inside the walk:

```ts
export function planReuse(originalRuns, tree, parentRunId?, rerunSet?: Set<string>): ReusePlan {
  ...
  for (const node of walkNodes(tree.body)) {
    if (!RUN_PRODUCING_TYPES.has(node.type)) continue;
    if (rerunSet?.has(node.id)) continue;               // ≥K: never plan reuse, so the node re-runs
    ...
  }
}
```

The caller at `run-workflow.ts:279` passes `rerunSet` **only for the root run**, so a nested file's
coincidental id collision (ids are unique only within a file, `plan-reuse.ts:16-18`) can never be
suppressed by mistake:

```ts
const rerun = params.identity.parentRunId === null && params.resume?.input.rerunFromNodeId
  ? rerunSet(file.body, params.resume.input.rerunFromNodeId) : undefined;
plan: resumeCounterpart ? planReuse(input.originalRuns, file, resumeCounterpart.runId, rerun) : new Map(),
```

Carry `rerun` onto the root run's `RunResume` (add `rerunSet?: Set<string>` to `RunResume`,
`run-context.ts:142-148`) so producer B can read it. Nested runs never receive it: the child's
`params.resume` is rebuilt with `input` + `counterpart` only (`run-workflow.ts:458-467`), so
`RunResume.rerunSet` is undefined for every non-root run — suppression is root-only for free.

**Producer B — `findNestedCounterpart` (`run-workflow.ts:461-465`).** A ≥K `workflow` node is now
absent from the root plan, so `runNode` dispatches it to `runWorkflowNode` (`run-workflow.ts:1192`).
Without a second guard it would re-enter its counterpart and reuse succeeded grandchildren — the
opposite of "subtree entire." Refuse the counterpart for a ≥K node so the subtree starts fresh:

```ts
counterpart: ctx.run.resume.rerunSet?.has(node.id)
  ? undefined                                           // ≥K workflow node: no re-entry, whole subtree re-runs
  : findNestedCounterpart(ctx.run.resume.input.originalRuns, ctx.run.resume.counterpart?.runId, node.id),
```

A fresh child (counterpart `undefined`) seeds from input, plans no reuse
(`run-workflow.ts:269-281`), and re-runs its whole tree — which is what ≥K demands. These two guards
are the whole change. The prefix (index <K) is never in `rerunSet`, so its ids plan and reuse
**bit-for-bit as today**.

### 4. Prefix loops / parallel keep today's behavior

No node walker changes. `runSequence` (`run-workflow.ts:1238-1259`), `runWhileDoNode`
(`run-workflow.ts:1088-1109`), and `runParallelNode` read reuse **only** through
`run.resume.plan.get(node.id)` (`run-workflow.ts:1168`) and the wait-one winner picker
(`plan-reuse.ts:111-124`). For any prefix id, `rerunSet` does not contain it, the guard at
`plan-reuse.ts` new-line is skipped, and the plan holds exactly the same rows plain Resume builds —
so a prefix loop reuses (or, for a >1-iteration loop, refuses to reuse under the existing uniqueness
guard `plan-reuse.ts:37`) **identically to today**. The multi-iteration-loop limitation is neither
fixed nor worsened; it stays out of scope, unchanged.

### 5. Plain Resume is the K = auto-boundary special case

When `rerunFromNodeId` is undefined, `rerun` is undefined, `planReuse` receives no set, the guard
never fires, and `findNestedCounterpart` runs exactly as today — **the existing resume path, byte for
byte.** So there is one code path, not two. And plain Resume already *is* Resume-from-K at the
auto-boundary: plain Resume reuses every succeeded node and re-runs the rest, and the rest are
precisely the top-level nodes from the first non-succeeded one onward — none of which own a succeeded
row to reuse anyway. Setting K to that first non-succeeded top-level node produces a `rerunSet` whose
ids have no succeeded rows, so suppressing them changes nothing: Resume-from-K(auto) ≡ plain Resume.
Resume-from-K is therefore a strict superset — it only ever suppresses reuse the operator explicitly
asked to discard.

### 6. Persistence / back-compat for the follow-up (#429)

- **Wire contract.** `ResumeInput.rerunFromNodeId` is engine-internal; the operator-facing surfaces
  must carry K: a new optional field on `ResumeBodySchema` for `POST /v0/runs/:root_run_id/resume`
  (`resume-run.ts:9-13`) and a `path resume --from <node-id>` flag in `cli.ts`. Both default to
  undefined = plain Resume, so old clients are unaffected.
- **Resumable-status gate.** The route today rejects an already-**succeeded** run — `"already
  succeeded; there is nothing to resume"` (`resume-run.ts:68`, and only a "finished-but-unsuccessful"
  run is resumable, `resume-run.ts:61-64`). Resume-from-K is a deliberate re-run of a **succeeded**
  region, so #429 must relax this gate when K is supplied: a succeeded root run is a valid
  Resume-from-K target. This is the one behavioral back-compat decision the follow-up must make.
- **K validation.** K must name a **top-level** node of the *current* file (`file.body`), per the
  map's constraint. `rerunSet` returns empty on `findIndex < 0` (`plan-reuse.ts` new helper), but the
  route should reject an unknown or non-top-level K with a distinct 4xx reason rather than silently
  degrading to plain Resume (the file may have been edited since the source run — a moved/renamed K
  survives by id, a deleted K does not).
- **No new run-row column.** ≥K nodes write ordinary fresh `succeeded` rows; <K nodes write reuse
  rows (#257) exactly as plain Resume does. `RunRecord` needs no `rerun` field
  (`packages/schema/src/run-record.ts`). One **optional** nicety for #429: record K on the successor's
  root row (a nullable column) so the viewer can label "resumed from node X"; not required for
  correctness.
- **Resumed-from unchanged.** `resumed_from_root_run_id` stays one hop (`CONTEXT.md:340-342`,
  `run-workflow.ts:759`); Resume-from-K does not touch lineage.

## Summary

| # | Answer | Key cite |
| - | ------ | -------- |
| 1 | New `ResumeInput.rerunFromNodeId?: string`; set in `Project.resume`. | `run-workflow.ts:126-131`, `project.ts:243-246` |
| 2 | Rerun set = run-producing ids in `walkNodes(body.slice(indexOf(K)))`. | `plan-reuse.ts:33-34`, `node-walk.ts:120` |
| 3 | Two guards: skip `rerunSet` ids in `planReuse`; refuse counterpart for ≥K `workflow` node. Root-only. | `plan-reuse.ts:34-37`, `run-workflow.ts:279`, `run-workflow.ts:461-465` |
| 4 | Walkers read reuse only via `plan.get`; prefix ids untouched. | `run-workflow.ts:1168`, `1088-1109` |
| 5 | `rerunFromNodeId` undefined ⇒ today's exact path; K=auto-boundary ≡ plain Resume. | `run-workflow.ts:279`, `755` |
| 6 | #429: wire field, relax succeeded-run gate, validate K, no new row column. | `resume-run.ts:9-13, 61-68` |

## Flagged / not determined

- This is a static reading of the reuse producers and their two consumers. No running Resume-from-K
  engine exists (#427 is a map). The claim rests on the invariant that reuse fires **only** at
  `run-workflow.ts:1168` and `461`; a future reuse consumer added elsewhere would need the same guard.
- The recommendation deliberately keeps `rerunSet` a plain id set rather than an index range, so a K
  that survives a rename/move by id (CONTEXT § Identity, `CONTEXT.md:144-147`) still resolves; the
  cost is the one `findIndex` at set-build time.
- Not analyzed: whether `path resume --from` should accept a human node *name* and resolve it to an
  id at the CLI edge. That is a UX choice for #429; the engine seam is id-only.
