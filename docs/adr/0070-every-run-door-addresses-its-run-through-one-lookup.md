# Every run door addresses its run through one lookup

**Status:** accepted.

Seven `/v0/runs/*` handlers each resolved the run a request names for themselves: they called
`archive.tree(rootRunId)` directly, hand-wrote the same `no run found with id "…"` message seven
times, and restated the same rule as a comment in three different wordings — "read the **root** row,
never a child", because a child can read `succeeded` while the tree still runs, so a terminality
verdict taken from one refuses a live cancel. Only `cancel` had a test for it (a hand-seeded orphan
child row under a root with no root row); `delete` and `resume` inherited the rule untested, and
`resume` re-implemented the same `404` a second time further down to patch a TOCTOU window.

`RunTree.root` already carries the fact (`null` exactly when the tree has rows but not the root
row), so the duplication was in the doors, not in the archive.

## Decision

1. **One module owns run addressing**: `routes/resolve-run.ts`, over `RunArchive`.
2. **Three address kinds, named by what they need.**
   - `resolveTree(ctx, rootRunId)` — the tree, or the `404`. For **read** doors (the detail, the
     event stream, a blob), which print a row of their own choosing and can still report a tree whose
     root row is missing.
   - `resolveRun(ctx, rootRunId)` — the tree **and its root row**, or the `404`. For **acting** doors
     (cancel, delete, resume): without the root row there is no status to gate the action on, so the
     door refuses rather than guessing at a child's.
   - `resolveLeaf(ctx, stepRunId)` — the leaf, its tree, and its root row (`null` when absent), or
     the `404`. For `POST /v0/runs/:step_run_id/complete`, which needs the leaf for its
     compare-and-swap and the root row for the workflow path.
3. **The refusal wording lives with the address**, one message per kind, so the doors cannot drift.
4. **Door policy stays in the door.** Terminality (`409`), the already-succeeded resume refusal, the
   awaiting CAS, the lease, and `delete`'s second `404` when `remove` finds nothing are per-route
   decisions, not addressing; the module returns rows and one `404`, never a status verdict.
5. **The root-row rule is tested at the module's own interface**, once, beside the HTTP tests that
   pin each door.

## Considered Options

- **One address module** (chosen). The rule and its wording have one home, and the orphan-child case
  is testable without seeding a database and driving HTTP.
- **Keep the per-route lookups, add the missing tests.** Rejected. It keeps seven copies of the rule
  and makes each new run door a fresh chance to read the wrong row.
- **Resolve the run in the dispatcher and inject it into the request.** Rejected. The route table
  matches method and path; it cannot know whether a door needs the root row or would rather report a
  root-less tree, and a dispatch-time lookup would also fire for routes that take no run id.
- **Move the rule into `RunArchive`.** Rejected. The archive's docblock already states its boundary:
  it knows what is stored, and leaves "which of its `null`s a caller reads as a `404`" to the server.

## Consequences

- **A new run door reads one of three addresses** instead of reaching for the archive.
- **`get-run` keeps its view-only tolerance**: a tree whose root row is missing still reports, with
  its status taken from the earliest row, and `resolveTree` is the name that says why.
- **The orphan-child rule is tested once at the module** and each acting door keeps its behavioural
  test.
- **No wire change.** Statuses, messages and bodies are unchanged; the existing HTTP tests pin them.
