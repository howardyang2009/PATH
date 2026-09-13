# Complete is a durable engine re-invocation over the appendable tree, not a held process

A `person-activity` step that returns `{ status: "awaiting" }` may wait days. The engine does **not** hold a live process or an in-memory promise for that whole wait. The awaiting run persists to the store (`runs` row with `status = awaiting` and no output blob) and the engine may tear down entirely. Completion is a *fresh engine invocation*: `POST /v0/runs/:step_run_id/complete` reopens the same **run tree** through the appendable-tree mechanism (**Model Q**, shared with debug-stepping #419), restores the awaiting workflow-run's context, reloads the workflow file, appends the person's output as the leaf's output blob, moves the leaf to `succeeded`, and continues the run from there. It appends to the existing tree; it does not mint a new successor root the way Resume does.

## Considered options

We considered a **held-process model**, which is what the first-cut `CompletionRegistry` implements: the engine suspends the awaiting step on an in-memory deferred (`completions.wait(runId)`) and the Complete route resolves it (`live.complete`). That is simple and keeps context in memory, but it makes an `awaiting` run only as durable as the process that launched it. A person taking a day, a deploy, or a crash loses every parked run — the run row says `awaiting`, but nothing can ever complete it. Since the whole point of person-activity is an offline human action on human timescales, in-memory holding fails the core requirement. So the deferred/registry path is a **placeholder** to be replaced by the Model Q reopen path; it is not the target design.

We also considered making Complete a **Resume** (mint a fresh successor root run that reuses the prefix). Resume already reopens work from the store, so the plumbing overlaps. But Resume's contract is a new tree with new root-run identity, reuse rows, and a `resumed-from` hop — a heavy, operator-facing action for what is really "the same run, one leaf finished." Model Q is exactly the exception that lets a tree be reopened and *appended to* in place; person-activity shares it with debug rather than paying Resume's successor-tree cost.

## Consequences

- `awaiting` survives an engine restart *as a row*, but a live tree does not. A parked run resolves through the Complete re-invocation, never through a still-running process. If a tree was never completed, Resume re-runs the step (it re-enters `awaiting`).
- Complete must locate and reload the workflow file (via source-workflow identity), the same requirement Resume carries. A moved file or relocated store must still resolve.
- The reopen/context-restore machinery is **one mechanism**, not two: person-activity Complete and debug Continue (#419) both drive Model Q. A change to how a tree is reopened lands in one place.
- The current `CompletionRegistry` + `live.complete` code is transitional. It is superseded by the Model Q reopen path and should not be treated as the engine contract.
