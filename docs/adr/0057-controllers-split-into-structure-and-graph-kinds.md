# Controllers split into Structure and Graph kinds; `goto` narrows the no-DAG stance

**Status:** accepted. Resolves the controller taxonomy for Wayfinder map
[#544](https://github.com/howardyang2009/PATH/issues/544), ticket
[#555](https://github.com/howardyang2009/PATH/issues/555). Records the boundary that the `goto`
execution model ([ADR 0053](0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md))
made drawable. Narrows, and does not reverse,
[ADR 0029](0029-designer-canvas-is-the-block-grammar-no-arbitrary-dag.md).

Until `goto`, every controller was a block of the nested block grammar, and the glossary said so: "the
block grammar realizes it." `goto` (#478) is a controller too (no worker, no task, no run: invariant 1),
but the block grammar does not realize it. It moves the walk to a node that is not the structural
successor, and a first-level node can run more than once in one workflow-run. One word for both kinds
hides the one property a reader must know first: whether the body still executes as a tree.

## Decision

1. **A controller is exactly one of two kinds.**
   - A **Structure Controller** is realized by the nested block grammar: single-entry, single-exit,
     output-threaded, each node in its body visited at most once per entry. The five are `parallel`,
     `sequence`, `branch`, `while-do` and `checkpoint`. A `while-do` iteration is a fresh entry, so the
     rule holds per iteration.
   - A **Graph Controller** adds routing that the tree cannot express. `goto` is the only one.

   Both kinds keep invariant 1. The single term **Controller** stays as the umbrella, and the glossary
   and invariant 1 name both kinds.

2. **`person-switch` is not in this taxonomy.** It is a shipped Step-Template that composes a
   `person-activity` step and a `branch`
   ([ADR 0052](0052-person-switch-is-a-shipped-step-template-not-a-controller.md)). Its routing is data
   plus a `branch` condition, so it adds nothing a Structure Controller cannot express. It belongs to
   the Templates taxonomy.

3. **A new Graph Controller needs its own ADR.** The bar is that the new control construct routes to a
   non-successor node, so its execution is not a tree walk. A construct that nests as a block is a
   Structure Controller and joins the grammar in the usual way.

4. **`goto` coexists with ADR 0029 by narrowing it, not by adding a DAG.**
   - The file format stays a **tree**. A goto is an ordinary node in an ordinary slot. Its route is a
     `target` **name** property ([ADR 0056](0056-a-goto-names-its-target-by-step-name-checked-at-load-in-path-schema.md)),
     not an edge, in the same way dataflow is a dot-path interpolation and not a canvas wire.
   - The Designer canvas still draws no edges and still authors only the block grammar. It authors a
     goto as a node with a `target` field.
   - The routing is confined: only a file's top-level walk follows it, a target is always a first-level
     node of the same file, and a goto never sits under `while-do` or `parallel` (ADR 0053 §3–4).
     Inside every nested body, Structure Controller semantics are unchanged.
   - ADR 0029's rejection of a **real DAG** (arbitrary dependency edges, multiple predecessors
     scheduled by the engine, a new body shape) stands. `goto` is the one recorded exception to "the
     tree is also the execution order", and it applies only at the top level of a file.

## Considered options

- **Keep one Controller term and list `goto` beside the others.** Rejected: a reader cannot tell from
  the term whether a construct keeps the one-visit-per-node rule that resume matching, audit and the
  canvas layout rely on.
- **Make `goto` a non-controller (a step type or an engine directive).** Rejected: a step type would
  push routing into a worker, and invariant 1 already names the class of worker-less engine constructs.
- **Treat `goto` as the start of the DAG door ADR 0029 left open.** Rejected: `goto` changes no body
  shape and adds no edge, so it does not touch the schema, scheduling or resume costs that ADR 0029
  guards. Calling it a DAG would invite edges on the canvas.

## Consequences

- Code, specs and issues use **Structure Controller** and **Graph Controller** exactly. "Controller"
  alone means either kind.
- Any rule that depends on one visit per node (plan reuse by id, the Designer's tree layout, a join's
  output keys) is a Structure Controller rule. Where `goto` breaks it, the per-pass container run
  ([ADR 0054](0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md)) restores it inside each
  pass.
- A request for a second Graph Controller (for example, a jump into a nested body or a cross-file
  jump) is a new ADR against ADR 0029 and ADR 0053, not a schema feature request.
