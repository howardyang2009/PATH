# A sequence body is transparent to the rerun boundary

**Status:** accepted. Tracked by [#638](https://github.com/howardyang2009/PATH/issues/638). Amends the locus rule of
[ADR 0035](0035-resume-rerun-boundary-is-a-suppression-set-on-the-two-reuse-producers.md) and
[ADR 0036](0036-resume-rerun-boundary-is-a-per-level-plan-reuse-override.md).

Until now a **rerun boundary (K)** had to be a **first-level node** of its level's file body
(`CONTEXT.md` § Rerun boundary (K)). A node inside any control block was refused as `in-body`,
including a node inside a `sequence`. That refusal is too strict for `sequence`. Workflows written under
`path/workflow@5` wrap each stage in a `sequence` (a person-activity step, then a `branch` of `goto`s),
so every useful step sits one `sequence` deep and no step can be a K. A real case: in
`jira-workflow.workflow.json`, `choice-test` is the first child of the `sequence` named `test`, and
Resume from `choice-test` is refused.

The top-level rule exists to keep "serialized before K" and "serialized after K" well defined. Loop,
parallel, and branch bodies break that: a loop body has per-iteration identity (the retired #420/#426
problem), parallel siblings are concurrent, and a branch arm taken in the predecessor may not be taken
in the successor. A `sequence` has none of these properties. Its children run one after another, once,
in file order. And a `sequence` owns no run row (invariant 1), so its children already run directly
under the level's scope run, exactly like first-level nodes.

## Decision

A `sequence` body is **transparent** to the rerun boundary. At each level, the boundary is located in
the level's **serial order**: the file body with every `sequence` node replaced by its children,
recursively through nested sequences, and never through a `while-do`, `parallel`, or `branch`.

```
body:          backlog, design{choice-design, on-choice}, test{choice-test, on-choice-3}, close{...}
serial order:  backlog, choice-design, on-choice, choice-test, on-choice-3, ...
```

- **Legal locus.** K (and every intermediate `workflow` path-node) must be an element of its level's
  serial order. Equivalently, every ancestor between the level body and K is a `sequence`. A node with
  a `while-do`, `parallel`, or `branch` ancestor at its level stays refused as `in-body`, and the refusal
  names the innermost such controller.
- **One primitive.** `@path/schema` gains one function that computes the serial order. Every place that
  today locates the boundary by a top-level `findIndex` locates it by index into the serial order
  instead: `classifyLevelK` (locus #2/#3 and prefix #5), `rerunBoundaryIndex` and `rerunDisposition`
  (Producer B), `buildSuppressSet` (Producer A), and `descendNodePath` (intermediate path-nodes).
- **Dispositions per serial element.** Elements before B reuse, B descends or re-runs entire, and
  elements after B re-run entire. A `while-do`, `parallel`, `branch`, or `workflow` node inside a
  sequence is one serial element and keeps its whole-subtree disposition.
- **No new identity or storage.** A `sequence` is never a path level because it makes no run. The
  descent path stays the node-id chain of run-producing nodes (`rerunFromNodePath` unchanged), the wire
  shape is unchanged, and no column is added.
- **The `sequence` node itself is never K.** It owns no run, so no run id selects it.

## Considered Options

- **Serial order through `sequence` only** (chosen). Keeps "before" and "after" a total order, which is
  what the reuse plan and the prefix rule need. One primitive feeds every reader, so the engine
  authority and the Designer's eager mirror (both through `classifyLevelK`) cannot disagree.
- **Keep the top-level rule and ask authors to flatten.** Rejected. The `path/workflow@5` single-node
  container slots (ADR 0014) make `sequence` the normal way to group a stage, and a `branch` arm holds one
  node. Flattening is not always possible, and it makes the file worse to read to satisfy Resume.
- **Make `sequence` a path level of its own.** Rejected. A path level is a run scope, and a `sequence`
  has no run. It would need a new run row or a synthetic level with no rows, and both break invariant 1.
- **Also open `branch` bodies.** Rejected for now. The arm a successor takes can differ from the
  predecessor's, so "after K" is not defined across the arm boundary. Out of scope, as in ADR 0036.

## Consequences

- **Both producers change together.** If only Producer A (`buildSuppressSet`) moved to the serial order,
  Producer B (`rerunDisposition`) would still see a sequence child as "not a top-level node" and degrade
  it to `rerun-entire`. That over-re-runs a `workflow` or `while-do` placed before K in the same
  sequence. The change is not correct until both read the same serial order.
- **The prefix rule is unchanged in shape.** Prefix = serial elements before K, walked with
  `walkNodes`. A `branch` before K contributes its steps, and an untaken arm has no run so it does not
  gate. Under a goto, earlier passes still count whole (ADR 0054 §6), and a goto target stays a
  first-level node (ADR 0058), so pass entry is unaffected.
- **Context replay is unaffected.** Resume replays reused nodes' `publish` in walk order from the seed
  (ADR 0062). Serial order is walk order for sequence children, so replay sees the same sequence of
  writes.
- **Strict superset.** A body with no `sequence` has serial order equal to its body, so every existing
  first-level K behaves byte for byte as before. Plain Resume is unaffected.
- **Designer eligibility under goto passes.** The Designer mirror must treat a run whose parent is a
  goto pass run of the root as a first-level candidate, so it runs the same locus check the engine runs.
  Today it skips that check and enables the button for a K the engine then refuses.
- **Refusal wording.** The engine's `in-body` message names the actual innermost controller (`loop`,
  `parallel`, or `branch`) instead of a fixed "loop, parallel, or branch".
- **CONTEXT.md** § Rerun boundary (K) changes "at the first level of its own file's body" to "in the
  serial order of its own file's body (first level, or inside `sequence` blocks only)".
