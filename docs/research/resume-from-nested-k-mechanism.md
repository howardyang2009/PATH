# Resume-from-nested-K: how the engine expresses a per-level (path-structured) rerun boundary

Research ticket [howardyang2009/PATH#433]. It generalizes the rerun-boundary mechanism from #428 —
**a root-only suppression set of run-producing node ids** — to a **per-level suffix chain** that lets
the boundary sit inside a nested `workflow` file. This revises the #427 locked constraint "K limited
to a top-level sequence node," but only to allow K inside a nested file; K inside a loop/parallel body
stays out of scope (§6).

Primary source: this codebase at `research/resume-from-nested-k-mechanism` (branched off `main`,
`e48d3b2`). All cites are `file:line`. Reads on the two facts #428's map rests on: reuse fires at
**exactly two producers** — `planReuse` (`plan-reuse.ts:27-40`, consumed at `run-workflow.ts:1168`)
and `findNestedCounterpart` (`plan-reuse.ts:59-67`, consumed at `run-workflow.ts:461-465`) — and node
ids are **unique only within one file** (`plan-reuse.ts:15-18`). No engine source changes in this
ticket; it is the mechanism map that the assembly ticket #432 builds on.

## Why #428 does not cover it

#428's boundary is a suppression set computed **once, root-run-only**, over the root file's top-level
slice, and it is deliberately withheld from every child run: a nested run's `params.resume` is rebuilt
with `input` + `counterpart` only (`run-workflow.ts:458-467`), so the set never reaches a child's
`planReuse`. A `≥K` `workflow` node gets its counterpart refused, so its **whole** subtree re-runs.

A nested K needs the **opposite** at the containing level: **partial** reuse *inside* a child run —
reuse the inner prefix, re-run from K onward — which requires suppression to reach a child's
`planReuse`, the one place #428 withholds it. And a flat root-only id set cannot express a boundary
that differs **per level of the descent**. The boundary is therefore not one set but a **chain**, one
boundary per level.

## The current model in one paragraph

`Project.resume` reads the whole original tree's rows, swaps each reuse row for its source
(`project.ts:224-228`), and hands the engine a `ResumeInput = { originalRuns, readBlob }`
(`project.ts:243-246`; type at `run-workflow.ts:126-131`). `runWorkflow` finds the original root run
(`run-workflow.ts:720`) and passes it as the root run's counterpart (`run-workflow.ts:755`). Each
workflow-run then computes its **own** reuse plan over its own scope —
`planReuse(originalRuns, file, counterpart.runId)` (`run-workflow.ts:279`) — a `Map<node_id,
RunRecord>` of the succeeded direct children (`plan-reuse.ts:27-40`). Reuse then fires in exactly two
places: a run-producing node short-circuits when `run.resume.plan.get(node.id)` hits
(`run-workflow.ts:1168`, applied `1175-1178`); a non-reused `workflow` node **re-enters** its nested
counterpart via `findNestedCounterpart` (`run-workflow.ts:461-465`), and that child run reuses its own
succeeded grandchildren. Reuse recurses into every non-succeeded nested workflow-run (`run-workflow.ts:455-467`).

## The semantics to realize

Descent path root → N1 (`workflow`) → … → containing-workflow → K, expressed as an ordered list of
node **ids** (#429 resolves it by walking the source run's `parentRunId` to root; `CONTEXT.md` §Resume
"Rerun boundary (K)"). At **each** level on the path the level's **path-node** B is the path element at
that depth, and every top-level node of that level's body has one of three **dispositions**
(`CONTEXT.md` §Resume):

- **reuse** — nodes serialized **before** B (as plain Resume today);
- **rerun-entire** — nodes serialized **after** B (subtree entire), and B itself when B is the last
  path element (B == K);
- **descend** — B when it is an intermediate `workflow` node: re-entered with **partial** reuse under
  the next level's boundary.

Intermediate path-nodes are `workflow` nodes by necessity (only a `workflow` node has child runs to
descend). Only K may be a leaf.

## Recommendation: the smallest viable change

Replace #428's single `rerunFromNodeId` + root-only `rerunSet` with a **path** on `ResumeInput` and a
**per-level suffix** on `RunResume`. On-path-ness becomes structural — only the node whose id equals
the suffix head receives a tail — so ids stay file-scoped by construction. Two producers are guarded,
now at **every on-path level**, not root-only. No new node walker; the prefix at every level reuses
bit-for-bit as today.

### 1. How the path enters a run and threads to each level

Replace `ResumeInput.rerunFromNodeId` with the whole path (`run-workflow.ts:126-131`):

```ts
export interface ResumeInput {
  originalRuns: RunRecord[];
  readBlob: (run: RunRecord, filename: string) => JsonValue;
  /** Descent path of node ids root→…→K. [] / undefined = plain Resume. Length 1 = top-level K (#428). */
  rerunFromNodePath?: string[];
}
```

It is set by the one caller that builds `ResumeInput`, `Project.resume` (`project.ts:243-246`). The
value originates one hop out at the wire edge (`POST /v0/runs/:root_run_id/resume` and `path resume`);
that plumbing and the run-id→id-path resolution are #429's, not this ticket's.

Carry a **per-level remaining path** on `RunResume` (`run-context.ts:142-148`):

```ts
export interface RunResume {
  input: ResumeInput;
  counterpart: RunRecord | undefined;
  plan: ReusePlan;
  /** The remaining descent path from this level down; head = this level's path-node B. [] = off-path / plain Resume. */
  rerunSuffix: string[];
}
```

The **root** run seeds `rerunSuffix = input.rerunFromNodePath ?? []` (`run-workflow.ts:275-281` /
`755`). Each descent into the path-node passes `suffix.slice(1)`; every off-path sibling passes `[]`
(§3). An empty suffix at any level ⇒ that run behaves exactly as plain Resume today (§5).

### 2. How each level computes its two sets

At a level with body `B[]` (the file's top-level node array, `WorkflowFile["body"]`), non-empty suffix
`S`, `head = S[0]`, `i = B.findIndex(n => n.id === head)`, `isLeaf = S.length === 1`:

```ts
// A ≥K/after-B walk, subtree entire, reusing planReuse's own walk (walkNodes over RUN_PRODUCING_TYPES,
// plan-reuse.ts:33-34). walkNodes never descends a `workflow` ref (plan-reuse.ts:19-21), so for a
// workflow node this yields only the node's own id — its subtree is forced fresh by the guard in §3.
const runProducing = (nodes) => [...walkNodes(nodes)].filter(n => RUN_PRODUCING_TYPES.has(n.type)).map(n => n.id);

// producer A — planReuse suppression: B and everything after it. Always includes B, so B never
// reuses-whole (it must descend or rerun).
const suppress = new Set(runProducing(B.slice(i)));

// producer B — counterpart refusal: rerun-ENTIRE only. Equals `suppress` minus B when B descends.
const rerunEntire = isLeaf ? suppress : new Set([...suppress].filter(id => id !== head));
```

`suppress` and `rerunEntire` differ by **exactly one element — B — and only when B is intermediate**.
That one-element gap is the third disposition: B is *suppressed from reuse* (so it does not
short-circuit) **and** *given a tail* (so it descends), which no single #428 set can express.

The predicate is precise for all shapes, exactly as #428 (its §2), because it is the same walk:
- an after-B **leaf** — its own id is in both sets;
- an after-B **logicer** (`while-do`/`parallel`/`sequence`) — no run row of its own (invariant 1,
  `CONTEXT.md:170-172`); `walkNodes` descends it, so its run-producing descendants land in both sets;
- an after-B **`workflow`** — only its own id is in the set (`walkNodes` does not descend the ref); its
  subtree is forced fresh by the §3 counterpart refusal;
- **B intermediate** — in `suppress`, absent from `rerunEntire`: descend.

### 3. How the three dispositions are realized at the two producers

**Producer A — `planReuse` (`plan-reuse.ts:27-40`).** Add an optional `suppress` set and one guard in
the walk, and pass it at **every on-path level** (contrast #428's root-only pass):

```ts
export function planReuse(originalRuns, tree, parentRunId?, suppress?: Set<string>): ReusePlan {
  ...
  for (const node of walkNodes(tree.body)) {
    if (!RUN_PRODUCING_TYPES.has(node.type)) continue;
    if (suppress?.has(node.id)) continue;   // B and after-B: never plan reuse
    ...
  }
}
```

Built and passed at `run-workflow.ts:279`, keyed off this run's own `rerunSuffix` rather than
`parentRunId === null`:

```ts
const S = params.resume?.rerunSuffix ?? [];
const suppress = S.length ? suppressSet(file.body, S[0]) : undefined;   // undefined ⇒ off-path / plain Resume
plan: resumeCounterpart ? planReuse(input.originalRuns, file, resumeCounterpart.runId, suppress) : new Map(),
```

Because `suppress` is derived from **this level's own `file.body`** and its own suffix head, and an
off-path run carries `[]`, a nested file's coincidental id collision can never suppress the wrong node
(`plan-reuse.ts:15-18`). File-scoping is preserved not by "root only" but by "on-path only," threaded
structurally.

**Producer B — the descent site (`run-workflow.ts:458-467`).** A B-or-after-B `workflow` node is now
absent from this level's plan, so `runNode` dispatches it to `runWorkflowNode` (`run-workflow.ts:1192`).
Compute the child's disposition from `rerunSuffix`:

```ts
const S = ctx.run.resume.rerunSuffix;
const isPathNode = S.length > 0 && node.id === S[0];
const descend = isPathNode && S.length > 1;                 // intermediate B: descend-partial
resume: ctx.run.resume
  ? {
      input: ctx.run.resume.input,
      counterpart: descend || !rerunEntire.has(node.id)     // descend, or before-B / off-path: re-enter as today
        ? findNestedCounterpart(ctx.run.resume.input.originalRuns, ctx.run.resume.counterpart?.runId, node.id)
        : undefined,                                          // after-B, or B==K workflow node: fresh, subtree entire
      rerunSuffix: descend ? S.slice(1) : [],                // hand the tail only to the path-node
    }
  : undefined,
```

- **descend** (intermediate B): re-enter the counterpart (restore context `run-workflow.ts:264-274`,
  plan reuse over its children), and hand it `S.slice(1)` so it applies its own boundary.
- **rerun-entire** (after-B, or B == K and K is a `workflow` node): counterpart `undefined` ⇒ the child
  seeds from input, plans no reuse (`run-workflow.ts:269-281`), re-runs its whole tree.
- **reuse / off-path** (before-B): before-B nodes are in the plan and short-circuit at
  `run-workflow.ts:1168`, never reaching this site; any other off-path child re-enters with `[]` and
  behaves as plain Resume.

These are the whole change: a `suppress`-set guard in `planReuse`, and a three-way disposition at the
descent site, applied at every on-path level via the suffix.

### 4. Cascade-up is mechanical, not a dataflow pass

Nodes serialized after the containing `workflow` node re-run entire at **every ancestor level** because
`rerunEntire` at each level holds every run-producing id after B (§2), so every after-B sibling and its
subtree reruns — at the root and at each descended level alike. The suffix chain visits each ancestor;
each ancestor's `rerunEntire` covers its own after-B tail. The "input of the after-B nodes changed" is
the *reason* the operator wants them re-run; the *mechanism* is the after-B rule, no dataflow analysis.

### 5. Superset preserved — one code path

- **Empty path** (`rerunFromNodePath` undefined/`[]`): `rerunSuffix = []` at every level, `suppress`
  undefined, both guards skipped, `findNestedCounterpart` runs as today — the existing resume path,
  byte for byte.
- **Length-1 path** (`[K]`, K a top-level node of the root file): root `head = K`, `isLeaf = true`,
  `suppress == rerunEntire == runProducing(body.slice(indexOf(K)))`, no descend — **exactly #428**.
- **K at the auto-boundary**: the length-1 case where K is the first non-succeeded top-level node, whose
  ids own no succeeded rows, so suppressing them changes nothing ≡ plain Resume.

So Resume-from-nested-K is a strict superset of #428, which is itself a strict superset of plain Resume.

### 6. Loops / parallel and the locus constraint

- **Prefix loops / parallel** (index < B at every level) behave exactly as plain Resume: no node walker
  changes; `runSequence`, `runWhileDoNode` (`run-workflow.ts:1088-1109`) and `runParallelNode` read
  reuse only through `plan.get(node.id)` (`run-workflow.ts:1168`) and the wait-one winner picker
  (`plan-reuse.ts:111-124`). A prefix id is never in `suppress`, so the plan holds exactly the rows
  plain Resume builds. The multi-iteration-loop reuse limit (a while-do body's id repeats per iteration,
  so an id with >1 succeeded candidate does not reuse, `plan-reuse.ts:23-25, 35-37`) is neither fixed
  nor worsened.
- **Locus constraint** (revised #427): each path element is a **top-level node of its own level's file
  body**, so "serialized before/after" is a well-defined top-level index (`B.findIndex`) at that level.
  A path element nested inside a `branch`/`parallel`/`while-do` body — where "after" is ambiguous across
  the block boundary, and where a loop body's per-iteration identity is the retired #420/#426 problem —
  inherits #427's out-of-scope limitation, unchanged.

### 7. Path-mismatch and validation (seam with #429)

The id-path is matched against the current file: a rename or move of a node survives (matched by id),
a **delete fails** (`CONTEXT.md` §Resume). That verdict lives at the wire edge: **#429 validates that
the whole path resolves against the current tree before the successor starts** (one legible error
naming the missing node, mirroring #428's "reject an unknown or non-top-level K with a distinct 4xx").
The engine therefore treats a per-level `i < 0` as an **internal invariant violation** (throw), not a
silent degrade to plain Resume.

One edge to flag: an intermediate B whose original counterpart is absent (the node was added since the
source run) can only arise if validation was skipped; `findNestedCounterpart` returns undefined, the
child seeds fresh and plans no reuse (`run-workflow.ts:269-281`), so it **over-re-runs** rather than
mis-reuses — safe, but a sign the #429 gate was bypassed.

### 8. Persistence / provenance (owned by #429, unchanged here)

- The successor persists the path as `rerunFromNodePath` (`{nodeId, nodeName}[]`, null on plain Resume,
  `CONTEXT.md` §Resume), a read denormalization derivable from the successor's own rows (at each level,
  the first child with a genuine-execution row, not a reuse row). Not load-bearing for correctness.
- `resumed_from_root_run_id` stays one hop (`CONTEXT.md:340-342`, `run-workflow.ts:759`); nested-K does
  not touch lineage.
- ≥K nodes write ordinary fresh `succeeded` rows; <K nodes write reuse rows (#257) exactly as plain
  Resume; `RunRecord` needs no new field.

## Summary

| # | Answer | Key cite |
| - | ------ | -------- |
| 1 | Replace `rerunFromNodeId` with `ResumeInput.rerunFromNodePath: string[]`; per-level `RunResume.rerunSuffix`. | `run-workflow.ts:126-131`, `run-context.ts:142-148`, `project.ts:243-246` |
| 2 | Per level: `suppress = runProducing(body.slice(i))`; `rerunEntire = suppress` minus B when B descends. | `plan-reuse.ts:33-34`, `node-walk.ts` |
| 3 | `planReuse` gets `suppress` at every on-path level; descent site chooses reuse / rerun-entire / descend. | `plan-reuse.ts:34-37`, `run-workflow.ts:279`, `458-467` |
| 4 | Cascade-up is the after-B rule applied per level; mechanical, no dataflow pass. | `run-workflow.ts:1168`, §2 |
| 5 | Empty path ≡ plain Resume; length-1 ≡ #428; K=auto ≡ plain Resume. One code path. | `run-workflow.ts:279`, `755` |
| 6 | Prefix loops/parallel unchanged; path through a logicer inherits #427 out-of-scope. | `run-workflow.ts:1088-1109`, `plan-reuse.ts:23-25` |
| 7 | #429 pre-validates the whole path (delete fails); engine throws on per-level `i < 0`. | `run-workflow.ts:279`, `CONTEXT.md` §Resume |

## Flagged / not determined

- Static reading of the two reuse producers and their consumers. No running Resume-from-K engine exists
  (#427 is a map). The claim rests on reuse firing **only** at `run-workflow.ts:1168` and `461-465`; a
  future reuse consumer added elsewhere would need the same `suppress` / suffix guard.
- The suffix is a plain id chain, not an index chain, so a path element that survives a rename/move by
  id (`CONTEXT.md` §Identity) still resolves; the cost is one `findIndex` per level at set-build time.
- Not analyzed: whether `path resume --from` accepts a human node *path* and resolves it to ids at the
  CLI edge (a UX choice for #429; the engine seam is id-only), and the exact 4xx reasons the #429 route
  returns for a missing / non-top-level / through-a-logicer path element.
