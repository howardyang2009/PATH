# Awaiting is a leaf-only run status; parents do not propagate it

Only a leaf-step run ever carries the `awaiting` status: the person-activity worker returns `{ status: "awaiting" }` and the run suspends until an external Complete. A root run and every enclosing workflow-run stay `running` while a descendant awaits. The `awaiting`-ness reads at the leaf that holds it (its status row, its `step-awaiting` log event, its glyph on the run surfaces), never rolled up to a parent. `running` on a parent stays truthful: the run is in progress, and the leaf tells you where it is parked.

## Considered options

We considered propagating `awaiting` upward: a workflow-run would report `awaiting` when no direct child is `running` and at least one is `awaiting`, so an operator glancing at the root could see the whole tree parked on people. We rejected it. Because a parent's status is stored (not derived at read time), propagation demanded a recursive cascade up the ancestor chain on every leaf park and resume, a new persisted status transition on each parent row, and a brand-new reverse log event (`step-resumed`) — the first "left a non-terminal wait" event in the set, since a leaf only ever moves on to `step-finished`. That machinery was not worth the root-level visibility, which the per-leaf glyph already gives at the node that matters.

## Consequences

- A run tree parked entirely on human action still shows the root as `running`. A surface that wants to signal "nothing is executing" derives that from the child rows itself; the audit model does not encode it.
- The log stream stays a leaf-level narrative. `step-awaiting` marks the one leaf; there is no parent transition event and no `step-resumed`.
- `awaiting` is separate from debug's `paused` (waiting for a debugger, #419), which is not yet a run status. A run holds `awaiting` when it waits for a person.
