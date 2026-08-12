# `cost()`'s run-tree graph has no consumer; it stays shallow

Status: accepted

An architecture review flagged `run-archive.ts` as shallow around the run tree: `subtreeCost` rebuilds
a parent→children adjacency map and DFS-walks it inline, `cost` sums that walk and reaches across trees
through reuse-markers, and `blockingSuccessors` resolves a back-reference over a full-table marker scan.
The proposed deepening was to give `RunTree` — the read-side abstraction that already owns `root`,
`events`, `blob`, `output` — the run-tree *shape* it re-derives, so those three free functions ask the
tree instead of rebuilding it.

The facts do not support the deepening, and this ADR records why so a later review does not re-raise it
from scratch.

- **`cost()` has no production caller.** Only `run-archive.test.ts` exercises it. It is recent
  (cost-SUM crossing tree boundaries, #176/#186), built ahead of a consumer — a `path runs` cost column
  or a server cost route — that has not landed. `subtreeCost` and the cross-tree reuse-reach exist
  *solely* to serve it, so they have no reader to be made deep *for*.
- **`blockingSuccessors` is not a subtree walk.** It is a membership test — which live successor trees
  hold a reuse-marker naming a run inside the target tree — with a single caller, the `runs rm` guard,
  run once per deletion. It never needs the adjacency `subtreeCost` builds.
- **`RunTree`'s server consumers want no graph.** `get-run`, `cancel-run`, `get-run-events`,
  `get-run-blob`, and `live-runs` read only `.root`, `.events()`, `.blob()`, `.output()`. None asks for
  parent/children or a subtree.
- **The one real run-tree adjacency build lives elsewhere.** `client-core`'s `buildRunTree`
  (`run-tree.ts`) builds `childrenByParent` and nests in execution order — over `RunNodeState`, the SSE
  view model, in a downstream package the engine cannot depend on. It shares neither a caller nor a row
  type with `subtreeCost`.

Resolution: **the `cost()` graph is not deepened.** `RunTree` gains no subtree API. `cost()` and its
helpers are retained as-is — unread infrastructure kept, not deleted, because the cost is a few
functions and a caller may yet arrive. The `subtreeCost` / `buildRunTree` similarity is a coincidence of
two small adjacency builds on different row types in different packages, not a duplication worth a shared
abstraction. Revisit only when a second run-tree-graph consumer appears **on `RunRecord`** — a real cost
reader, or a server-side tree renderer over db rows rather than the live view model.

## Considered Options

- **Deepen now — give `RunTree` the subtree/adjacency it re-derives.** Rejected. Deepening concentrates
  complexity behind a seam so its *readers* reason about less; here the only reader of the concentrated
  logic (`cost()`) is itself unread. The deletion test asks whether removing the shallow thing
  concentrates complexity or merely moves it — with no consumer downstream, there is no complexity to
  concentrate, only speculative code to decorate.
- **Extract a shared adjacency primitive** — `adjacencyByParent<T extends { runId; parentRunId }>` /
  `walkSubtree` in a low module both `engine` and `client-core` import, unifying `subtreeCost` and
  `buildRunTree`. Rejected. The two instances share no caller and no row type, and `engine` must not
  depend on `client-core` (wrong direction), so unifying means a new package edge and a generic seam to
  satisfy a DRY instinct over ~6 lines each. It makes neither site simpler to read — the deletion test
  fails.
- **Delete `cost()` and its helpers as dead code.** Rejected *for now*, not on principle. Removing
  unread speculative infrastructure is a legitimate simplification, but it is a separate decision from
  this deepening question, and `cost()` is cheap to keep against a plausible near-term caller. If the
  caller does not materialize, delete it then.
- **Leave as-is and record the reasoning.** Chosen. Nothing changes in the code; this ADR is the whole
  of it, so a future `improve-codebase-architecture` pass reading `run-archive.ts` finds why the obvious
  deepening was declined rather than re-proposing it.
