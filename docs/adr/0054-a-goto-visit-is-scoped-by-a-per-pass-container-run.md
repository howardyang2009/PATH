# A goto visit is scoped by a per-pass container run

**Status:** accepted. Resolves run identity for repeated visits under `goto` for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#548](https://github.com/howardyang2009/PATH/issues/548). Builds on
[ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md) (goto execution
model) and extends the reasoning of
[ADR 0037](0037-while-do-iteration-is-a-per-iteration-run-scope.md) (while-do iteration scope).
Plan-only: no engine code yet.

A backward `goto` makes one first-level node run two or more times in one workflow-run. Every row
under that run then repeats `(parentRunId, nodeId)`, and so does every inner row: a first-level
`branch`, `sequence` or `parallel` has no run row of its own, so its inner leaves are direct children
of the workflow-run too. `planReuse` and `findNestedCounterpart` refuse a key with more than one match,
so a Resume would re-run every repeated node, and a log reader could not tell which visit a row
belongs to. `while-do` hit the same wall and fixed it with a container run per iteration (ADR 0037).

## Decision

1. **A pass is a container run.** A **pass** is one forward stretch of the top-level walk: from the
   start of the body, or from a jump target, up to the next jump taken or the end of the body. The walk
   always holds one open pass. Every run made while it is open (first-level nodes and everything
   nested in them) takes the pass as its parent. A jump closes the open pass and opens the next one;
   the end of the body closes the last. Within one pass the walk only moves forward, so each
   first-level node runs at most once, and `(scope, node id)` uniqueness holds inside the pass by
   construction. Example: `[A, B, check]` where `check` jumps to `B` twice gives pass 1 = `A, B,
   check…`, pass 2 = `B, check…`, pass 3 = `B, check…`. A pass holds only what the walk ran in it.

2. **Only a file that contains a `goto` node has passes, always from pass 1.** This is decided at load
   time from the file, so one file always yields one tree shape, whether or not a jump is taken.
   Goto-free files keep today's tree exactly.

3. **Row shape: a new `pass` run kind with its own field `pass: number | null`.** The field is the
   1-based ordinal, non-null exactly on a pass container. A new guard `isPassRun` is its one reader,
   beside `isIterationRun`. `RunKind` becomes `root | nested-workflow | leaf | reuse | iteration |
   pass`. `nodeId` / `nodeName` name the **goto node that opened the pass**, `null` for pass 1. This is
   safe for `planReuse`: a goto id is never a step id, so the scan skips it (the same reason a while-do
   container is safe). A pass is worker-less and shares the workflow-run's context: it is a
   run-identity and reuse scope, not a context boundary (as ADR 0037).

4. **Status.** A pass closed by a jump or by the end of the body is `succeeded`. A pass in which a node
   fails, or in which `max_jumps` runs out (ADR 0053 §6), is `failed`, and the workflow-run fails with
   it. A pass holding a parked `person-activity` leaf stays `running` (ADR 0038, ADR 0042).

5. **Resume pairing: same ordinal and same opening goto, whatever the status.** When the replayed walk
   opens pass N, it pairs with the predecessor's pass whose `pass === N` **and** whose `nodeId` is the
   goto that just fired (`null` for pass 1). It re-enters that pass with a `planReuse` scoped to it,
   whether the old pass `succeeded`, `failed` or was `cancelled`, so a failed pass reuses its succeeded
   nodes and re-runs from the failure. On a mismatch (no such pass, or a different opening goto), that
   pass and every later pass run fresh: the walk has left the record (invariant 4).

6. **Resume-from-K inside a pass.** K may be a first-level node inside pass N (never an inner node of a
   first-level `branch`/`sequence`/`parallel`). Passes 1 to N-1 reuse by rule 5. Inside pass N, the
   nodes before K reuse, and K and the rest of pass N re-run. Every later pass runs fresh. Legality
   keeps today's prefix rule, counted across passes: K succeeded, and everything serialized before it
   succeeded. The `rerunFromNodePath` entry for the level whose K sits in a pass gains an optional
   `pass: N`.

7. **Log: a new `pass-started` event**, the twin of `iteration-started`. It fires when a pass opens and
   carries `pass: N`. Its `node_id` / `node_name` name the opening goto (`null` for pass 1). The
   container's own `step-started` / `step-finished` still fire. The jump itself stays the job of
   `goto-taken` (#600).

8. **Disk: no change.** `.path/runs/<root-run-id>/<run-id>/` is keyed by run id, and every visit and
   every pass has its own.

## Considered options

- **A visit ordinal on every row** (`A-1, B-1, A-2…`, a flat tree, reuse keyed by `(scope, node id,
  visit)`). Rejected. Every reuse reader (`planReuse`, `findNestedCounterpart`, the wait-one replay)
  and the K descent path must learn the key, and it must be stamped on inner rows as well. It would
  also leave PATH with two mechanisms for "a node ran more than once", since `while-do` keeps its
  container.
- **A visit ordinal for both goto and while-do.** Rejected. Loops nest, so one number is not enough:
  a leaf needs a list of ordinals (goto visit, outer iteration, inner iteration), and ADR 0037's shipped
  container, run kind and Viewer grouping would need a migration. The container is what unifies the
  two: "a repeat gets its own parent row".
- **One container per node visit.** Works, but adds a row per first-level node per visit, and Resume
  pairs node by node instead of stretch by stretch.
- **One row per node, overwritten per visit.** Rejected: it breaks the append-only tree and the
  permanent predecessor (ADR 0001).
- **Passes in every workflow-run.** Rejected: every existing tree gains a level and every test
  re-baselines, for no gain in a goto-free file.
- **Open a container only at the first jump.** Rejected: pass 1's rows would sit directly under the
  run, so the shape depends on the path taken and Resume cannot pair pass 1.
- **Reuse the `iteration` column for the ordinal.** Rejected: one term would mean two things, and the
  guard would read two fields.
- **`nodeId` = the pass's entry node.** Rejected as unsafe: a succeeded pass carrying a step's id would
  look like that step's own run to `planReuse`.
- **Pair by ordinal alone** (the ADR 0037 rule). Rejected: after a file edit or a changed condition, a
  different goto may open pass N, and its nodes would reuse rows from a different stretch.
- **Pair only succeeded passes** (the `loopIterationResume` rule). Rejected: a loop body is usually one
  step, but a pass holds the whole top-level body, so a failed pass would re-run and re-pay most of
  the workflow.
- **The pass ordinal on `goto-taken` instead of a new event.** Rejected: pass 1 has no jump, so it
  would have no marker.

## Consequences

- In a file with a goto, the run tree gains one level under the workflow-run. `path runs`, the
  Viewer's run rail and the read-time cost SUM (`subtree`, `findRootRun`) read the same tree and
  follow it; the Viewer labels a pass "Pass N" and names its opening goto.
- `RunRecord` grows one nullable field, `pass`, added once in `RUN_RECORD_FIELDS`, so the wire codec,
  the db row and `blankRunRecord` follow. `LogEvent` gains `pass-started`.
- `planReuse`, `findNestedCounterpart` and the wait-one replay are unchanged inside a pass. The new
  code is the top-level walk opening and closing passes and the pass pairing of rule 5.
- The auto-boundary of plain Resume falls out of rule 5: the failed pass re-enters, and its first
  non-succeeded first-level node re-runs.
- Left to sibling tickets: rebuilding the per-goto jump counts from the record, Complete/awaiting
  replay across passes and divergence after a file edit (#599); the `goto-taken` payload (#600);
  context and publish behavior under cycles (#598); Designer rendering (#601).
