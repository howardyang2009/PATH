# `path/workflow@2` node semantics: load checks, sibling concurrency, the input chain

> **Status: draft wording.** Output of [#268](https://github.com/howardyang2009/PATH/issues/268),
> chartered under the wayfinder map [#265](https://github.com/howardyang2009/PATH/issues/265). Not
> yet quoted into a frozen spec: the `@2` spec (`docs/format/workflow-format-v2.md`) and the forced
> `mvp-spec` / `CONTEXT.md` edits graduate when the map freezes. This file holds the finalized `§5.3`
> / `§5.4` wording so the freeze step can quote it verbatim.

## What changed, in one line

`@2` deletes the `parallel`-branch wrapper `{id, name, body}`. **Every container slot now holds one
node** (`parallel.branches` is an array of nodes; an arm, an `else`, a `while-do` hold one node
each), plus a `sequence` logicer `{type, id, name, body:[node,…]}` for the multi-node case. Every
rule that today reasons about "a branch" as a thing distinct from a node is restated below over **the
branch node** — which may be a `sequence`, and whose rules must therefore reach *through* that
`sequence` into its children.

---

## 0. The primitive: a node's **publish set**

The three publish rules in §5.3 all quantify over "publishes inside this branch." In `@1` that meant
"any `publish` in the wrapper's `body` array." In `@2` a branch is one node, so define the scope once
and state the rules over it:

> A node's **publish set** is the set of `publish` keys declared on that node together with the
> publish sets of every node reachable through its child bodies (`node-walk` `childBodies`) — it
> reaches through a `sequence`, a nested `branch`/`while-do`/`parallel`, and any depth of nesting. It
> does **not** descend into a `workflow` step's ref'd file: that file has its own isolated context
> and its own load pass.

A nested inner `parallel`'s keys therefore count toward the enclosing branch node's publish set — an
inner key still lands at the inner join and propagates outward, so two sibling branches that each
reach the same key still collide. This is `@1` behaviour (`collectPublishKeys` already walks the full
subtree); `@2` states it out loud.

---

## 1. §5.3 — the duplicate-publish load checks

Restated over the publish set of a **branch node** (`parallel.branches[i]`, itself possibly a
`sequence`):

- **`collect`.** Publish keys are static strings, so a key that appears in the publish sets of **two
  concurrent sibling branch nodes** of one `collect` `parallel` is a last-writer race and is a
  **load error**. (Within a single branch node the same key may appear more than once — e.g. two
  steps of its `sequence` — and does not collide with itself: they are sequential, deterministic
  last-writer, landing before the next node.)
- **`wait-one`.** The same-key ban across sibling branch nodes is **lifted**: only the winner's
  publishes land, so two branches publishing one key is deterministic
  ([wait-one-join.md](wait-one-join.md) §4.1).
- **`do-not-wait`.** A branch node's publish set must be **empty** — no `publish` anywhere reachable
  within the branch node, *including through a `sequence` or any nested block*. A non-empty publish
  set is a **load error** ([do-not-wait-join.md](do-not-wait-join.md) §4). The detached branch lands
  after its would-be readers, so any write would be a nondeterministic write-after-read.

**Mechanics (unchanged from `@1` except the walk).** The `collect` check keys on
`childBodies(...).concurrent`; the `do-not-wait` check latches `insideDoNotWait` once a `do-not-wait`
`parallel` is entered and descends every child body. Both already walk `childBodies` recursively, so
the *only* change is `childBodies` gaining a `sequence` case (§2) — through which the recursion then
reaches. No load-check logic changes.

---

## 2. §Q2 — `node-walk` `childBodies`: sibling concurrency after the wrapper dies

The `NodeChildBody` interface loses `branchName` and keeps `concurrent`:

```ts
interface NodeChildBody {
  nodes: WorkflowNode[];        // a one-node slot returns [thatNode]; sequence/top-body return the array
  path: (string | number)[];
  concurrent: boolean;          // branchName removed
}
```

- **`branchName` is deleted.** It existed only because a `@1` branch wrapper's `name` **was not a
  node's name** (`node-walk.ts:12`). In `@2` the branch is a node; its name is `node.name`, found by
  the ordinary node walk. Its one reader — the `collectNames` special case — is deleted, not
  relocated (§3).
- **`concurrent` survives.** "Can these sibling bodies race to publish?" is intrinsic to the block
  type, not the wrapper: `true` for `parallel` branches, `false` for `branch` arms (one runs),
  `while-do` body (iterations sequential), and `sequence` children (ordered).
- **`sequence` is a new `childBodies` case**, returning `{ nodes: node.body, path: ["body"],
  concurrent: false }`. The `never`-guard in `childBodies` forces this case to exist or nothing
  compiles.
- **One-node slots return a single-element array.** A `parallel` branch, an arm's node, an `else`
  node, and a `while-do`'s node each return `{ nodes: [thatNode], … }`. No new return shape; every
  consumer already takes `WorkflowNode[]`.

**Does any consumer break? No — one gets shorter.**

| Consumer | Reads | `@2` effect |
| --- | --- | --- |
| `collectNames` | `branchName`, `nodes` | Special case deleted; branch-node name swept by the normal per-node walk. |
| `findDuplicatePublishKeys` | `concurrent`, `nodes` | No logic change; walks `[branchNode]` subtree. |
| `findDoNotWaitPublishes` | `nodes` (recursive) | No logic change; latch now descends through `sequence`. |

---

## 3. §Q3 — name uniqueness and the `collect` key

- **Scope unchanged.** `name` stays unique **file-globally, at every nesting level**.
- **The `branchName` special case in `collectNames` is deleted, not relocated.** A `@1` branch
  wrapper's name was collected separately because it was not a node; in `@2` a branch node's name is
  an ordinary node name swept by the normal walk — same scope, one fewer special case.
- **The `collect` key is exactly the branch node's `name`, including when that node is a
  `sequence`.** Key = the `sequence`'s `name`; value = the `sequence`'s output object (= its last
  child's output, §5.4). Required and file-globally unique already, so no new rule.

---

## 4. §5.4 — node output objects and the default-input chain

Every `@1` phrase assuming a multi-node body — "the taken arm's **last node's** output," "the
branch's **last node**," "the **first node** of any block slot" — collapses, because each slot now
holds **one** node:

- **Branch**: the taken arm's **node's** output.
- **While-do**: the **node's** output of the final executed iteration; transparent at zero
  iterations.
- **Parallel (collect)**: `{ "<branch-node-name>": <the branch node's output object> }`.
- **Parallel (wait-one)**: `{ "winner": { "name": <winning branch node's name>, "output": <that
  node's output> } }`.
- **Parallel (do-not-wait)**: the empty object `{}` (unchanged).
- **Sequence**: its **last child's** output object. This is the *only* new output clause `@2` adds,
  and it is the pre-existing sequence rule, not a new one.

**Default-input chain.** The first node of any block slot — an arm, a `parallel` branch, a `while-do`
node — defaults to the **block's predecessor's output object** (parallel siblings all start from that
same snapshot). A `sequence` needs **no new clause**: its first child defaults to the `sequence`'s
predecessor's output, its later children chain internally — identical to the existing arm / branch /
loop-body rule.

The `while-do` cross-iteration line is reworded from `@1`'s "first node / last node" to the single
node it now holds:

> **iteration 1's node reads the block's predecessor's output; iteration N's node reads iteration
> N−1's node's output.**

(The node being possibly a `sequence`, whose own first-child / last-child chaining is the sequence
rule, not a `while-do` rule.)

---

## Carry-forwards this does not decide

- The `childBodies` rewrite, load-error message text, and the codemod are the **build map**
  ([#272](https://github.com/howardyang2009/PATH/issues/272)) — this file states the *contract* they
  must meet, not the code.
- No new ADR: the container-shape trade is recorded by the map's own ADR; the wording above is a
  faithful restatement of settled rules, not a fresh trade with alternatives lost.
