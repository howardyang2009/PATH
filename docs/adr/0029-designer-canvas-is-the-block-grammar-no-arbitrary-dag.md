# The Designer canvas is the block grammar; no arbitrary DAG

**Status:** accepted; resolves the constrained-canvas question of Wayfinder map
[#254](https://github.com/howardyang2009/PATH/issues/254) (assembled at
[#263](https://github.com/howardyang2009/PATH/issues/263)). Applies map **decision 6** (a constrained
node canvas: the author can never express a structure the block grammar cannot) and its **Out of scope**
"real-DAG door." Builds on map [#265](https://github.com/howardyang2009/PATH/issues/265)
(`path/workflow@2` is a uniform single-node container format — a **tree**) and
[#269](https://github.com/howardyang2009/PATH/issues/269) (the `@2` correction: `@2` is *not* the DAG;
the DAG, if ever wanted, is a later unnumbered door). The interaction and palette contract is
[docs/spec/designer-spec.md § Canvas interaction model](../spec/designer-spec.md) and § The v1 authoring
palette.

This decision earns a record on the three-part bar. It is **hard to reverse** (a DAG extension touches
`@path/schema`, the engine, resume matching, and every existing `*.workflow.json`). It is **surprising
without context** (a "node canvas" that forbids edges is not what a reader expects from one). And it is a
**real trade-off** (authoring expressiveness against the tree model's simplicity).

## Decision

The canvas authors **only `path/workflow@2`'s block grammar.** A workflow body is an **ordered tree of
nodes with nested blocks** — `parallel`, `branch`, `while-do`, `sequence` — never an arbitrary DAG. The
author can never draw an edge or express a structure the grammar cannot: an illegal structure is
**unsnappable**, not merely rejected on save (§ Canvas interaction model). Dataflow between nodes is a
**dot-path interpolation** authored in the properties pane (`${context.}` / `${output.}`, live-checked),
**never a canvas wire**.

**Extending the format to a real DAG is rejected here.** If it is ever wanted it is its own future map (an
unnumbered door, *not* `@2`), because it is not a canvas feature — it is a different execution model.

## Considered options

- **A free node-graph editor with arbitrary edges (a real DAG).** Rejected. It would touch `@path/schema`
  (a new body shape), the engine (arbitrary-dependency scheduling in place of the tree walk), resume
  matching (plan reuse keys off tree position), and **every existing `*.workflow.json`**. The whole model
  — one input and one output per step, context as the only cross-node channel (CONTEXT.md) — rests on the
  tree. A DAG is not a canvas feature; it is a different product.
- **Author the tree, but let the canvas draw dataflow edges as a visual-only convenience.** Rejected. An
  edge the grammar cannot express re-introduces the DAG mental model the format rejects, and a
  "visual-only" edge that a save silently drops lies about what was authored. Dataflow stays a pane
  interpolation, live-checked, so an ill-typed reference is caught in the pane — the structural analogue
  of the unsnappable socket.
- **A free-form JSON editor (no author-time grammar constraint; validate on save).** Rejected by map
  decision 4 (the model is a node canvas, not a JSON editor) and by the palette's refuse-to-open stance
  ([ADR 0026](0026-designer-refuses-to-open-a-file-with-an-unregistered-step-type.md)): validity is
  registry-relative and enforced at author time, not deferred to a save round-trip.

## Consequences

- **Reversing this** (a real DAG) is the single most expensive hypothetical the map guards — schema,
  engine, resume, and a migration of every workflow file. Hence this record, so a future reader treats
  "add edges to the canvas" as a new map, not a feature request.
- **The constraint is tightened, not merely stated.** The palette offers only grammar-legal blocks at
  each socket, so an illegal body is *unrepresentable* rather than rejected (§ Canvas interaction model,
  § The v1 authoring palette).
- `path/workflow@2` (map #265) stays a tree, so the branch-arm identity workaround
  ([#256](https://github.com/howardyang2009/PATH/issues/256)) dissolves under it and is not specified.
  This ADR does not wait on #265's freeze: the two maps run in parallel, and the `@2` container shape is
  settled enough to author against (per #269).
