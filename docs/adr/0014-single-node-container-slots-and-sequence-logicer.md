# Single-node container slots, and a `sequence` logicer for the array

**Status:** accepted; freezes the two structural rulings of `path/workflow@2`
([workflow-format-v2.md](../format/workflow-format-v2.md), map
[#265](https://github.com/howardyang2009/PATH/issues/265)). The format doc fixes the contract. This ADR
records *why* the shape is what it is, and the alternatives weighed and rejected, the reasoning a reader
of the format would otherwise have to reconstruct.

`@2` makes one structural change and nothing else: **every container slot holds exactly one node.** Two
rulings compose that change: what the slot holds (a node, not a wrapper), and how a slot that genuinely
needs several nodes says so (a `sequence` logicer, not an optional `body` on every node). Each is
recorded below with its rejected alternatives.

## Decision 1 — every container slot holds a single node

A `parallel` branch, a `branch` arm's occupant, an `else`, and a `while-do` body are each **one node**.
The `@1` branch wrapper `{ id, name, body }`, an object that was *not* itself a node, is deleted. An arm
becomes `{ when, node }`. `parallel.branches` becomes an array of nodes directly.

Why:

- **Arm and branch identity come free.** Every slot occupant is now a node, so `id` and `name` are the
  node's own: required, file-globally unique, already carried. There is no wrapper that holds a name
  that is "not a node's name." The `@1` branch-arm identity problem
  ([#256](https://github.com/howardyang2009/PATH/issues/256)), an arm that needs an identity distinct
  from the node it holds, **dissolves rather than being solved**.
- **`node-walk.ts:12`'s `branchName` special case is deleted.** The schema's node walker carries a
  `branchName?: string` field solely because "a `parallel` branch carries its own human `name`, which
  is not a node's; nothing else does." Once the branch *is* a node, that exception has no referent, and
  the field is removed. The walker reads a node's own `name` uniformly.
- **Three slot shapes become one.** `@1` had a branch wrapper, a bare-node slot, and a body array as
  three different things a container could hold. `@2` has two, distinguished by field name alone: a
  `body` (a node array, two places only, the file top level and a `sequence`) or a single `node` (every
  other slot). The grammar stops the branch on what kind of occupant a slot takes.
- **The migration is free today and gets more expensive with every multi-step slot written.** Across
  all 30 `*.workflow.json` in the repo there are **zero** multi-node container slots. Every `parallel`
  branch, `while-do` body, and `branch` arm already holds exactly one node, so the array is unused
  capacity in every file that exists. The codemod migrates 30/30 with **0 `sequence` nodes emitted and 0
  names minted**. This is the **counter-clock argument from
  [#109](https://github.com/howardyang2009/PATH/issues/109)**: unlike every other door in that register,
  this one's price *rises* with time. Each multi-node slot ever written is a `sequence` the codemod must
  later mint and name. The final measured multi-node-slot count is **0**, so the single-node reading is
  confirmed, and the door is cheaper to open now than to keep shut.

### Considered options (Decision 1)

- **Keep the `@1` branch wrapper (rejected).** It leaves the wrapper with a name that is not a node's,
  keeps the `branchName` special case, keeps three slot shapes, and leaves #256's arm identity problem
  to be solved rather than dissolved. Its only saving is no migration, and the migration is free today,
  dearer every later day.
- **Single node per slot (chosen).** Identity comes free, one walker path, one slot rule. It is paid
  for by a one-time codemod that is a no-op on today's files.

## Decision 2 — a `sequence` logicer, not an optional `body` on every node

For the case where a slot genuinely needs several nodes in order, `@2` adds a fourth logicer,
**`sequence`** `{ type, id, name, body }`, whose `body` is a node array. The array lives on one new node
type, not as an optional `body` field added to every node type.

An optional `body` on every node breaks in five ways:

1. **Two output objects on one node** (format §5.2 / CONTEXT invariant 3). A node with both its own
   output and a `body`'s output has no single defined output object.
2. **Ambiguous `publish` timing** (mvp-spec §5.3 / format §5.3). A node that both runs and holds a body
   has no defined point at which its `publish` lands relative to the body's.
3. **A second parent kind in the run tree** (CONTEXT invariants 1/2). Only run-producing nodes parent
   runs. A node that is both a step and a body-holder is a second, contradictory kind of parent.
4. **A field invalid on `checkpoint` and `workflow`.** `body` is meaningless on a `checkpoint`
   (condition only) and on a `workflow` step (its body is the ref'd file). So an every-node `body` would
   be a field the schema must forbid on two of the types it is added to.
5. **Behaviour keyed on field presence, not on `type`** (format §3). The engine would branch on whether
   `body` is present rather than on `type`. This violates the flat-union rule that behaviour depends on
   `type` and never on a field's presence or absence.

A dedicated `sequence` node avoids all five. It is one more `type` in the flat union, a logicer with no
worker, task, or run, whose output is its last child's and whose default-input chain is the pre-existing
block-slot rule. It **adds no new execution semantics**, only a place to put the array.

### Considered options (Decision 2), including the two rejected top-level shapes

- **Optional `body` on every node (rejected).** The five breaks above.
- **A single top-level `node` field on the file (rejected).** It would force a minted `sequence` name
  into every multi-node file. The file could no longer *be* its own outermost sequence, so any file with
  more than one top-level node would need an author-invented wrapper name. `@2` instead lets the file's
  `body` array be the file's own outermost sequence (format §2).
- **Merge the envelope with a `sequence` node (rejected).** It would put one `id` on both a run-bearing
  implicit root step and a run-less logicer. The root step (which owns the root run row and root
  lifecycle events) and a `sequence` (which never produces a run) cannot share one identity.
- **A dedicated `sequence` logicer (chosen).** One new flat-union type that carries the array, no new
  execution rules, envelope and root identity left intact.

## Consequences

- **Runtime contracts are unchanged.** Resume, cancellation, cost, the `collect`/`wait-one` output
  shapes, the duplicate-publish load checks, and the default-input chain all carry over from `@1`
  verbatim, restated over "a node" wherever `@1` said "a branch." The one genuinely new clause is
  `sequence`'s output object (its last child's), and that is itself the pre-existing block-slot rule
  (format §4.4, §5.2).
- **The `collect` key source moved, not its shape.** `collect` keys on the branch **node's** `name`
  where `@1` keyed on the wrapper's `name`. Across the repo these differ in 10 of 10 branches, so the
  codemod **renames each unwrapped node to its wrapper's `name`** (10 renames, 0 collisions) to keep
  emitted output byte-identical (format §11). The output shape a downstream stdin consumer sees is
  unchanged.
- **The logicer count grows from three to four.** `sequence` joins `parallel`/`branch`/`while-do`.
  `checkpoint` stays beside the logicers, not inside them, and no "special node" or "control node"
  taxonomy term is introduced (CONTEXT.md, format §4).
- **The build map owns the code.** Schema, engine dispatch, the `node-walk` rewrite, load-error message
  text, the codemod implementation, and the migration of the 30 files and their inline `.ts` fixtures
  are the build map's. This ADR and the format doc freeze the contract they must meet.
- **The Designer gains a drill-down level.** A `while-do` over three steps becomes while-do, then
  sequence, then steps, unless the canvas collapses a single-node slot visually. Whether a design
  surface shows a `sequence` as its own level is the Designer map's call (format §12). `@2` freezes only
  the file contract.
