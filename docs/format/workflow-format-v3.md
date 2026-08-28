# PATH Workflow File Format v3

This is the normative definition of `path/workflow@3`. `@path/schema` implements it as zod schemas. The
engine executes it. The vocabulary follows [CONTEXT.md](../../CONTEXT.md) (step, worker, task, run,
logicer, checkpoint, config vs context, output object, publish).

This document is **self-contained**: everything needed to author, validate, or interpret a
`path/workflow@3` file is stated here. It **supersedes** [`workflow-format-v2.md`](workflow-format-v2.md)
(which describes `path/workflow@2`, retained because the CHANGELOG and closed issues link it), matching
how `@2` treated `@0`.

## 0. What `@3` is

`@3` makes one change to the format and nothing else: **a worker is a *name*, not a tagged object.** The
`@2` `worker: { "type": "engine" }` / `worker: { "type": "llm", "model", "options" }` union is gone.

- A step's `worker` is now an optional **worker-name string** — one of the names its step type ships
  (`binary` → `spawn`, `prompt` → `sdk`). Omitted, the step uses its type's **default worker**. A step
  naming a worker its type does not ship fails at load with the valid names listed (§4.1).
- `model` and `options` are no longer worker fields. They are **config**, fixed as `config.model` and
  `config.options` (§7). `model` is literal config now, so it is no longer interpolable against context;
  one `config.model` at the file top inherits to every `prompt` step.
- There is **no file-level `worker`**. `@2` required one at the workflow level; `@3` has none — a worker
  is a per-step selection, and shared data such as `model` travels through config, which crosses the
  nested-file boundary (§7), where a worker never did.

Everything structural is inherited from `@2` verbatim: the single-node container slots, the four
logicers including `sequence`, the node identity model, and every runtime contract (resume,
cancellation, cost, the join output shapes, the duplicate-publish rules, the default-input chain). This
document restates them so it stays self-contained. The map's ADR
([ADR 0021](../adr/0021-built-ins-are-the-first-two-plugins-and-the-engine-llm-union-is-gone.md))
records the trade this change makes and the alternatives weighed. This document fixes the format.

## 1. File & envelope

- A workflow file is a single **JSON** document (UTF-8). JSON is the only syntax.
- Recommended file naming: `<name>.workflow.json`.
- Every file declares `"format": "path/workflow@3"`. This is identity and version in one required
  string, **exact-match validated**. An engine that does not speak the declared version **fails at
  load**.
- **The declared version does not track the set of step types.** `format` fixes the *grammar shape* —
  the container rules, the envelope, the common step fields — and it keys the codemod chain (§10). The
  set of valid **leaf step types** is a fact about the **step-plugin registry** the engine loaded, not
  about the format (§4). A file that uses a plugin-contributed step type is a `@3` file and stays one:
  a plugin type needs no codemod, because there is no earlier *shape* to lift such a file from. The
  thing it lacks on a given machine is a plugin folder, and the fix is to add one, not to run a script.
  (#315.)
- Validation is **strict**: unknown fields anywhere are rejected.
- **`@2`, `@1`, and `@0` files are rejected at load** with a targeted message that names the codemod, per
  the ADR 0007 precedent. It is never a generic zod "invalid literal" on `format`:

  ```
  path/workflow@2 is no longer read — run scripts/migrate-workflow-format-v3.ts to migrate this file to path/workflow@3
  ```

  The engine reads `@3` only. There is no dual reader. Migration is the one-time repo script
  [`scripts/migrate-workflow-format-v3.ts`](../../scripts/migrate-workflow-format-v3.ts) (§10), which
  follows its `@1`-to-`@2` and `@0`-to-`@1` predecessors.

  A file more than one version behind names its **whole codemod chain**, in the order the scripts must
  run, because each codemod migrates one step and skips anything else silently. Handed an `@0` file, the
  `@3` script reports "skipped" and leaves it untouched — so to name it alone would name a fix that is
  not one:

  ```
  path/workflow@0 is no longer read — run scripts/migrate-workflow-format-v1.ts then scripts/migrate-workflow-format-v2.ts then scripts/migrate-workflow-format-v3.ts to migrate this file to path/workflow@3
  ```

## 2. Top-level workflow object

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Exactly `"path/workflow@3"`. |
| `id` | yes | Durable GUID (UUIDv4) — the stable machine identity (§3). |
| `name` | yes | Workflow name, pattern `^[a-z][a-z0-9-]*$`. |
| `config` | no | The file's config defaults (§7). |
| `body` | yes | Non-empty **array of nodes** (§4). |
| `output` | no | Interpolation map defining the workflow's output object (§6.4). Absent = `{}`. |

There is **no file-level `worker`** (`@2` had one, required). A worker is a per-step selection now (§4.1);
shared data such as `model` travels through `config` (§7).

**The file's `body` is the file's outermost sequence.** The top level is the one place besides a
`sequence` node that holds a node array. It is a node sequence with the same semantics: nodes run in
order, each node's default input is its predecessor's output object (§6.1), and the file's output is
built from `output` at the end (§6.4). Rather than mint a `sequence` node to wrap the whole file, the
file simply *is* its own outermost sequence. This is a spec rule, not an inference. (Rejected: a single
top-level `node` field, because it would force a minted `sequence` name into every multi-node file; and
a merge of the envelope with a `sequence` node, because it would put one `id` on both the run-bearing
implicit root and a run-less logicer.)

There is **no input declaration**. The input object arrives at runtime (from the parent workflow-step,
or empty for a top-level run) and seeds the initial context (§6.3).

## 3. Conventions

- **Discriminator.** Every tagged union in the format discriminates on a single field named `type`:
  nodes and conditions alike (a worker is a plain name now, not a tagged union — §4.1). There is no
  second-level tag. Step kinds and logicers form
  **one flat node union**. Behaviour depends on `type`, never on the presence or absence of a field.
- **Identity — `id` + `name`.** The workflow and **every node** carry two identifiers. `id` is a
  durable **GUID** (UUIDv4): the stable machine identity, assigned once by the codemod and never
  regenerated. It is the reuse/resume key and the `node_id` that a run row and log event carry. `name`
  is the human label, pattern `^[a-z][a-z0-9-]*$`, **unique across the whole file** (all nesting
  levels). It keys `collect`/`wait-one` output objects, it is what the log stream narrates, and it is
  what error messages name.

  Because every container slot now holds a node, **`id` and `name` are free and required on every slot
  occupant**, including a `parallel` branch, an arm's node, an `else`, and a `while-do` body. There is
  no wrapper that carries a name that is "not a node's name." `@1`'s branch-wrapper name (which in `@1`
  had no `id` at all) is gone, and with it the branch-arm identity problem. An arm is now `{ when, node
  }`, and the node carries its own `id` and `name`.
- **The step-vs-logicer distinction** (only steps have workers, tasks, and runs) is a domain rule
  enforced by the schema, not an extra nesting level in the JSON.

### 3.1 The one naming rule

Two slot kinds, one rule, no exceptions:

- **A `body` field holds a node array.** Two places carry it: the workflow top level (§2) and a
  `sequence` (§4.4).
- **A `node` field holds a single node.** Three places carry it: a `while-do`'s `node`, a `branch`
  arm's `node`, and a `branch`'s `else`.

`parallel.branches` is **an array of nodes**. Each branch *is* a node, so the array holds nodes
directly, not wrappers. Every slot obeys the rule: a slot is either a `body` (many nodes, ordered) or a
single `node`, and the field name tells you which. Where a `node` slot needs several nodes in order, the
author puts a `sequence` there.

## 4. Node union

`body` and `branches` elements, and every single-`node` slot, are **nodes**. `type` is one of:

| `type` | Kind | Node-specific fields |
| --- | --- | --- |
| `prompt` | step | `prompt` |
| `binary` | step | `command`, `args?`, `cwd?` |
| `workflow` | step | `ref` |
| `parallel` | logicer | `join`, `branches` |
| `branch` | logicer | `arms`, `else?` |
| `while-do` | logicer | `condition`, `max_iterations`, `node` |
| `sequence` | logicer | `body` |
| `checkpoint` | — | `condition` |

Three step types, four logicers, and `checkpoint`. The logicer list grows from three to four (the new
`sequence`). `checkpoint` stays beside the logicers, not inside them. No "special node" or "control
node" taxonomy term is introduced. The taxonomy is otherwise unchanged from `@1`.

**The union has a closed half and an open half.** Six `type` values are **engine-owned and reserved**:
`workflow`, `parallel`, `branch`, `while-do`, `sequence`, and `checkpoint`. They are the constructs the
walker evaluates itself, they hold no worker and no run (CONTEXT invariant 1), and nothing can
contribute or replace them. Every *other* `type` value is a **leaf step type**, and that set is **open**:
it is exactly what the **step-plugin registry** holds, one entry per folder under
`packages/engine/step-plugins/`. `prompt` and `binary` appear in the table above because PATH ships
them, not because the format names them — they are plugin folders like any other
([ADR 0019](../adr/0019-step-plugins-are-folders-under-packages-engine-step-plugins.md)). A file is
therefore valid **against a registry**, never in the abstract; the same bytes load in a tree that holds
the plugin and fail in one that does not, both correctly. There is no `requires` block: the `type`
values in `body` *are* the file's dependency list, and a reader derives it with the walk it already has
(#315).

Step-type-specific fields sit **directly on the node** (no `payload` wrapper). A leaf step type's fields
cannot collide with the engine-owned ones (`type`, `id`, `name`, `worker`, `config`, `input`, `parse`,
`publish`): a plugin declares only its *extra*-field fragment and the schema layer composes the
envelope, rejecting a collision loudly at registry freeze
([ADR 0018](../adr/0018-open-node-union-via-pure-registry-factory.md) sub-decision 4).

### 4.1 Common step fields

All three step types additionally accept:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Durable GUID (§3). |
| `name` | yes | Human label, unique across the file (§3). |
| `worker` | no | The **worker-name** to run on. One of the step type's own worker names; omitted = the type's default worker. |
| `config` | no | Key-level override/extension of the inherited config (§7). |
| `input` | no | Builds the step's input object (§6.1). Absent = previous node's output object. |
| `parse` | no | `"text"` (default) or `"json"` (§6.5). |
| `publish` | no | Context writes from the step's output (§6.2). Absent = writes nothing. |

`worker` is a **name string**, not a tagged object: each step type ships one or more workers (a named
`run` method), and `worker` selects one by name — `binary` → `spawn`, `prompt` → `sdk`, each the default
of its type. A step naming a worker its type does not ship **fails at load** with the valid names listed
(the `(type, name)` pair is a worker's identity, so a name is meaningful only inside its type). A
`workflow` step takes **no `worker`**: it runs a nested run, not a worker.

Logicers (`parallel`, `branch`, `while-do`, `sequence`) and `checkpoint` take **none** of `worker`,
`config`, `input`, `parse`, or `publish`. They have no worker, no task, and no run.

### 4.2 Step types

**`prompt`** — `prompt` (string, interpolable) is the instruction text. Its worker (`sdk`, the Agent SDK)
receives the prompt plus the step's entire input object, rendered, and the **model** it runs on from
`config.model` (§7). There is no `context_refs` mechanism. What the step reads is exactly what its
`input` map builds. `config.model` is required for a `prompt` step; a step with none **fails at run
start**, not at load — config carries no per-key required declaration, so the check has no load to live
at (ADR 0021 sub-10). `config.options` is the SDK invocation bag (MCP servers, skills, system prompt),
passed to the worker verbatim.

**`binary`** — `command` (string), `args` (string array, default `[]`), and `cwd` (string, default: the
directory of the workflow file), all interpolable. A **relative `cwd` resolves against the directory of
the workflow file**, the same anchor as its default. It never resolves against the directory `path run`
was invoked from, so a workflow behaves the same wherever it is launched. I/O convention:

- The input object is written to the process's **stdin**: raw bytes if it is a string, otherwise its
  JSON serialization.
- The output object is the captured **stdout** (a string, unless `parse: "json"`).
- A **non-zero exit code fails the step** (and thus the run). stderr is not data. The engine captures it
  for audit (a per-step-run `stderr.txt`), and never passes it downstream.

**`workflow`** — `ref` (string, *not* interpolable) is a relative path to another workflow file,
resolved against the directory of the referencing file. The child run starts with a fresh context,
seeded only by its input object (§6.3). Data returns only through the child's `output` object. Config
crosses the boundary (§7), so a `config.model` set in the parent reaches the child's `prompt` steps
unless the child sets its own. A worker name never crosses: it is a per-step selection within a file.

### 4.3 Logicers

A logicer routes and coordinates step execution. The engine of its enclosing workflow evaluates it. It
has no worker, no task, and no run. So no logicer is ever a run row or a resume key (§5.5).

**`parallel`** — `join` is `"collect"`, `"wait-one"`, or `"do-not-wait"`. `branches` is a **non-empty
array of nodes** (§3.1). Each branch is a node that carries its own `id` and `name`.

- **`collect`** runs every branch and joins their outputs into
  `{ "<branch-node-name>": <that node's output object>, … }`. The key is the **branch node's own
  `name`**. **The output shape is unchanged from `@1`**: the same `{ name: output }` map keyed by a
  file-globally-unique name. Only the *source* of the key moved, from the deleted wrapper onto the node.
  (A reader who expects the `@1` contract to have broken here will find it has not: same keys, same
  values, same shape.)
- **`wait-one`** races the branches and keeps the first to succeed, and cancels the rest. Only the
  winner's publishes land. So two branches that publish one context key are allowed here (§5.3), where
  `collect` rejects it. Its output is the stable
  `{ "winner": { "name": <winning branch node's name>, "output": <that node's output> } }` shape,
  **unchanged from `@1`**, the winner named by its node's `name`.
- **`do-not-wait`** launches every branch and waits for none at the join. The block completes at once
  with output `{}`. A branch **may not `publish`** anywhere reachable within it (rejected at load, §5.3
  and §8).

See [wait-one-join.md](../spec/wait-one-join.md) and
[do-not-wait-join.md](../spec/do-not-wait-join.md).

**`branch`** — `arms` is a non-empty array of `{ "when": <condition>, "node": <node> }`, plus an
optional top-level `else` that holds **one node**. The arms are tested in order. The first arm whose
`when` (§9) is true has its `node` taken. If none match and there is no `else`, the run fails (§5.4).
Each arm's `node` and the `else` node carry their own `id` and `name`.

**`while-do`** — `condition` (a condition, §9) is checked before each iteration. While it is true, the
block's single `node` runs. `max_iterations` is a positive integer, or an interpolable string that
resolves to one. It is **required**. To exceed it fails the run. The body is one `node`.

**`sequence`** — see §4.4.

**`checkpoint`** — `condition` only. If it is true, the run continues. If it is false, the run stops as
failed, and that failure propagates as §5 (an ordinary run failure). It is mechanical assertions only.
Anything that needs judgment is a normal step that outputs a verdict, followed by a checkpoint that
tests it (the judge-step pattern). `checkpoint` is **unchanged** from `@1`.

### 4.4 `sequence`

`sequence` is the single-node grammar's answer to "this slot needs several nodes in order."

```json
{ "type": "sequence", "id": "<guid>", "name": "<name>", "body": [ <node>, … ] }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Exactly `"sequence"`. |
| `id` | yes | Durable GUID (§3). |
| `name` | yes | Human label, unique across the file (§3). |
| `body` | yes | **Node array, minimum length 1** — the nodes run in order. |

`sequence` takes **none** of `worker`, `config`, `input`, `parse`, or `publish`. It is a logicer, not a
step. It **adds no new execution rules**. Its semantics are exactly the existing block-slot rules:

- **Output object** is its **last child's** output object.
- **Default input** — its **first child** defaults to the `sequence`'s predecessor's output object. Its
  later children chain internally, each defaulting to its own predecessor's output. This is identical to
  how a branch arm, a parallel branch, and a loop body already default their first node (§6.1).
- **`body` minimum length is 1.** An empty `sequence` is a load error.
- **Nesting is legal.** A `sequence` may hold a `sequence`, to any depth. But it is never necessary (a
  flat `sequence` already holds any number of nodes), and the codemod never emits one.

Because a `sequence` is a node, it is a legal occupant of any single-`node` slot: a `while-do` body, a
branch arm, an `else`, or a `parallel` branch may each be a `sequence`. When a `collect` branch is a
`sequence`, the collect key is the `sequence`'s `name`, and the value is the `sequence`'s output (its
last child's output).

## 5. Execution semantics

This section fixes the runtime contracts the format implies. They are `@1`'s contracts restated over "a
node." Nothing here is new except the single `sequence` output clause (§4.4), which is itself the
pre-existing block-slot rule.

### 5.1 A node's publish set

Several rules below quantify over "the publishes inside a branch." A branch is now one node, so the
scope is defined once:

> A node's **publish set** is the set of `publish` keys declared on that node, together with the publish
> sets of every node reachable through its child bodies: through a `sequence`, a nested `branch`,
> `while-do`, or `parallel`, and any depth of nesting. It does **not** descend into a `workflow` step's
> ref'd file: that file has its own isolated context and its own load pass.

A nested inner `parallel`'s keys therefore count toward the enclosing branch node's publish set. An
inner key still lands at the inner join and propagates outward. So two sibling branches that each reach
the same key still collide. (This is `@1` behaviour, now stated out loud.)

### 5.2 Node output objects

Every step produces an output object (§6.5). Logicer output objects:

- **`sequence`** — its **last child's** output object.
- **`branch`** — the taken arm's **node's** output object.
- **`while-do`** — the **node's** output object of the final executed iteration; transparent (its
  predecessor's output) at zero iterations.
- **`parallel` / `collect`** — `{ "<branch-node-name>": <the branch node's output object>, … }`.
- **`parallel` / `wait-one`** — `{ "winner": { "name": <winning branch node's name>, "output": <that
  node's output object> } }`.
- **`parallel` / `do-not-wait`** — the empty object `{}`.
- **`checkpoint`** — transparent: its predecessor's output object passes through unchanged.

### 5.3 Duplicate-publish load checks

Publish keys are static strings, so publish races are detectable, and rejected, at load. Over the
publish sets (§5.1) of the branch **nodes** of a `parallel`:

- **`collect`** — a key that appears in the publish sets of **two concurrent sibling branch nodes** is a
  last-writer race and is a **load error**. (Within a single branch node, the same key may appear more
  than once, for example in two steps of its `sequence`. It does not collide with itself: the steps are
  sequential and deterministic last-writer, each landing before the next node.)
- **`wait-one`** — the same-key ban across sibling branch nodes is **lifted**. Only the winner's
  publishes land, so two branches that publish one key are deterministic.
- **`do-not-wait`** — a branch node's publish set must be **empty**. There must be no `publish` anywhere
  reachable within it, *including through a `sequence` or any nested block*. A non-empty publish set is
  a **load error**. The detached branch lands after its would-be readers, so any write would be a
  nondeterministic write-after-read.

### 5.4 Branch matching

`branch` arms are tested in declaration order. The first arm whose `when` condition is true is taken. If
no arm matches and no `else` is present, the run **fails**. (Whether `else` should become mandatory is
not decided by `@2`.)

### 5.5 Resume, cancellation, cost

> Resume, cancellation, and cost aggregation are invariant under `@2`. Reuse keys on a node's `id`, and
> only run-producing nodes (`prompt`, `binary`, `workflow`) produce a run. `sequence` and every branch
> node are logicers with no run (invariant 1). So none is ever a reuse key, a cancel cause, or a term in
> a run's cost SUM. A `wait-one` race still replays to the same winner: resume orders reused winners by
> recorded completion time, then by branch declaration order, both preserved when a branch is a node.
> (Build map: the `parallel` and `plan-reuse` consumers that today walk a branch wrapper's `body`
> re-target to the branch node; mechanical, no semantic change.)

### 5.6 Load-time validation

The engine loads the **whole file tree** (following `ref`s) before any step runs. It rejects:

- unknown `format` versions, including `@1` and `@0`, with the §1 targeted message; and any schema
  violation (strict zod, unknown fields rejected)
- duplicate or pattern-violating ids and names; an empty top-level `body`; an empty `sequence` `body`;
  empty `arms` or `branches`
- reference cycles between workflow files; unresolvable `ref` paths
- duplicate `publish` keys across concurrent sibling branch nodes of one `collect` `parallel` (§5.3)
- any `publish` in a `do-not-wait` branch node's publish set, caught anywhere below the block, including
  through a `sequence` or nested `collect`/`while-do`/`branch` (§5.3)
- malformed `${}` syntax in interpolable positions, and `${}` roots other than the allowed ones (§6)
- malformed config wrappers, and sole `$`-prefixed config keys that name no known wrapper (§7.3)

Authoring errors surface at load, never mid-run. An **unset `$env` variable is not a load failure**
(§7.3): it fails the run at start, before the first step.

## 6. Interpolation & data flow

### 6.1 Step input

`input` is **any JSON value**, interpolated. A map is the common case. But a bare `"${context.x}"`
(whole-string rule, §6.6) makes that value the entire input object, and literals are allowed. When
`input` is absent, the step's input object is the **previous node's output object**.

**The default-input chain** threads through every slot:

- At the **top level** and inside a **`sequence`**, the first node's default input is the **enclosing
  sequence's predecessor's output**. (For the very first node of a top-level run, it is the workflow's
  own input object.) Each later node defaults to its predecessor's output.
- The first node of a **block slot** (a branch arm, a `parallel` branch, a `while-do` body) defaults to
  the **block's predecessor's output object**. (Parallel siblings all start from that same snapshot.)
- A **`sequence` needs no special clause**. Its first child defaults to the `sequence`'s predecessor's
  output, and its later children chain internally. This is identical to the arm, branch, and loop-body
  rule.
- **`while-do` across iterations**: iteration 1's node reads the block's predecessor's output; iteration
  N's node reads iteration N−1's node's output.

### 6.2 Publishing to context

`publish` is a map of context-key from an interpolated value, with `output` available as a root
alongside `config` and `context`. It covers whole-object (`"${output}"`), rename, and deep-pick with the
one interpolation mechanism. A step without `publish` writes nothing to context.

### 6.3 Workflow input seeds context

At run start, each top-level key of the workflow's input object becomes a context key. Conceptually it
is the implicit root step's one write. Nodes read it via `context.*` in interpolation and conditions.
No separate `input` root exists.

### 6.4 Workflow output

The top-level `output` map (roots `config` and `context`) is evaluated at successful run end. It is the
workflow's output object: the explicit contract a parent's `publish` reads from. Absent = `{}`.

### 6.5 Output parsing

`parse: "json"` makes the engine parse a string output into a structured value before it becomes the
step's output object. For LLM output, the engine strips a surrounding markdown code fence first. If it
is unparseable, the step fails. The default `"text"` leaves the raw string. (This is why deep paths like
`context.verdict.pass` work: the judge step declares `parse: "json"`.)

### 6.6 Interpolation syntax

- Syntax: `${dot.path}` inside JSON strings. Escape a literal `${` as `$${`.
- **Whole-string rule.** If a string is exactly one placeholder, it resolves to the referenced value
  with its **real type** (`"max_iterations": "${config.max_revisions}"` resolves to the number).
  Otherwise the string is a **splice**: each part stringifies, and to splice a non-scalar (object or
  array) is a runtime error.
- Unresolvable paths are errors (strict).
- **Evaluated positions** (an allowlist; inert everywhere else, notably ids, `type` tags, `format`,
  `join`, `ref`, and condition trees, which have their own language):
  - step payload fields (`prompt`, `command`, `args`, `cwd`)
  - `input` values (§6.1)
  - `publish` values (§6.2) and workflow `output` values (§6.4)
  - `max_iterations`

  `worker` is a plain name string, and `config` (including `config.model` / `config.options`) is
  literal — neither is an evaluated position.
- **Roots**: `config` and `context`. In `publish` maps only, the additional root `output` (the step's
  own output object). Bare roots are valid (`"${output}"`, `"${context}"`). Paths are plain dot-paths
  (numeric segments index arrays; no wildcards).

## 7. Config

### 7.1 Literal values

Config is a JSON object of **literal values**. There is no interpolation inside config; it is a source,
not a consumer. A `${...}` string in config is that string, never a reference. The **one bounded
exception** is the sole-key `$` wrapper (§7.3).

A `prompt` step's `model` and `options` are ordinary config keys (`config.model`, `config.options`) — no
key is special-cased, so `model` inherits and is operator-overridable like any other, and `options`
becomes maskable with a `$secret` wrapper. Because config is literal, `model` cannot be chosen from a
predecessor's output; the file-top `config.model` is the common case, a step-level `config.model` the
override.

### 7.2 Composition

Composition is a **shallow merge per top-level key, nearest wins**:

```
step config  >  enclosing workflow's effective config  >  file's own config (defaults)
```

Operator launch-time values (CLI flags or file) override the top-level file's defaults the same way. At
a workflow-step boundary, the parent's effective config flows into the child file and shadows the
child's declared defaults key by key. Context is isolated; config deliberately is not. Steps never write
config.

### 7.3 Value wrappers and the reserved `$` namespace

Two wrappers are the one exception to §7.1's literalness. Both are **sole-key objects** that stand where
a literal value would:

| Wrapper | Means |
| --- | --- |
| `{"$secret": "<value>"}` | Marks the value for persistence-boundary redaction. |
| `{"$env": "<NAME>"}` | Sources the value from environment variable `NAME` at run start. |

They **compose by nesting**, not side by side: `{"$secret": {"$env": "NAME"}}` is a value both sourced
and masked. `$env` is the source, and `$secret` is the marking laid over it. So that is the only nesting
order.

A wrapper may sit **at any depth** inside a config value, inside objects and arrays alike, not only at
the value a dot-path lands on. `${config}` and `${config.nested}` resolve to whole sub-trees, and a
wrapper declared anywhere inside one still means what it means.

**When `$env` is read.** The engine resolves every `$env` in a run's config once at run start, before
anything is persisted. Unset variables **fail the run**. One failure names **every** missing variable
rather than the first, before the first step runs. The run is still recorded (it starts, ends `failed`,
and the error names the missing variables and their config keys). The **whole tree is checked**, so a
nested file's `{"$env": "KEY"}` requires that variable even when a parent's config shadows the key.
**Empty counts as set**; only an absent name is unset. The engine reads the **environment once per
run**.

**Sole key, or it is not a wrapper.** The marker must be the object's only key: `{"$secret": "x", "note":
"y"}` is an ordinary config object with a `$secret` field, not a marking.

**The `$`-sole-key namespace is reserved.** A sole-key object whose key begins with `$` and is not a
known wrapper **fails at load**. It names the key and lists what is known:

```
config.token: "$evn" is a reserved key — a sole "$"-prefixed key names a config wrapper (known: "$secret", "$env")
```

Config is a free-form key/value map, so §1's strict unknown-field rejection cannot reach inside it. The
reservation is what prevents a misspelled `{"$evn": "TOKEN"}` from silently reaching a worker as data.
Multi-key objects (`{"$foo": 1, "bar": 2}`) are plain config objects; a config object's own keys are
field names, not wrapper positions.

## 8. Do-not-wait publish ban

A `do-not-wait` branch node's publish set (§5.1) must be empty. A detached branch lands after its
would-be readers, so a `publish` from it is a nondeterministic write-after-read. It is a **load error**,
caught anywhere below the block, including one nested through a `sequence` or inside a
`collect`/`while-do`/`branch` within the detached branch. See
[do-not-wait-join.md](../spec/do-not-wait-join.md) §4.

## 9. Conditions

Zod-validated structured predicate trees, discriminated on `type`. Predicates: `exists`, `equals`,
`one-of`, `matches`, `range`, `valid-json`. Combinators: `all`/`any`/`not`. Dot-paths over roots
`context` and `output`. Error semantics are strict. Interpolation is never evaluated inside condition
trees. Conditions appear on `branch` arm `when`s, `while-do` `condition`, and `checkpoint` `condition`.

## 10. Migration from `@2`

The one-time repo script
[`scripts/migrate-workflow-format-v3.ts`](../../scripts/migrate-workflow-format-v3.ts) migrates `@2`
files, following its `@1`-to-`@2` and `@0`-to-`@1` predecessors. It is a committed repo-internal script,
not a shipped `path migrate` command. Pre-1.0 there are no external stored workflow files. It is a hard
bump-and-break: no compat read, because a compat read would have to synthesise `config.model` behind the
author's back.

**What the codemod does.** It is proven against every `*.workflow.json` in this repo (all migrated, 0
refused), idempotent (a file already at `@3` is left untouched):

- Bumps `format` to `path/workflow@3`.
- Deletes a `worker: { "type": "engine" }` wherever it appears (file level or a step) — the step reaches
  its type's default worker, which is what `engine` selected.
- Rewrites a `worker: { "type": "llm", "model", "options"? }` by deleting the key and writing its
  `model` / `options` into that same object's own `config` (the file's config for a file-level worker,
  the step's for a step-level one).
- Deletes `worker` on a `workflow` step outright.

It **never writes a `worker` name string**: every `@2` file reaches its type's default worker, because
`@2` shipped one reachable implementation per type. The name field is only ever *deleted*.

**What the codemod refuses.** It hard-fails, naming the file and the JSON pointer, on two classes it
cannot rewrite honestly (ADR 0021 sub-12), leaving the file byte-unchanged and exiting non-zero:

- **An interpolated `model` or `options`.** Config is literal (§7), so hoisting a `${…}` expression into
  config writes an inert string that no longer resolves — a silent behaviour change. The one benign
  sub-case is a `model` that is *exactly* `"${config.model}"` where `config.model` already resolves in
  scope: the hoist is then a no-op and the key is simply deleted.
- **A `prompt` step whose effective worker is `engine`.** It load-passes and run-fails today; after
  migration it would silently run on `sdk`, spending money the author never authorised. The codemod
  stops rather than migrate it.

No file in the repo hits a failing case, so the strict rule costs nothing today and closes both
silent-change classes forever.

## 11. Deferred and owned elsewhere

- **The build map** owns schema, engine dispatch, the codemod implementation, the audit rename, and the
  migration of the repo's files and their tests. This document freezes the contract they must meet, not
  the code.
- **A required-config-key mechanism.** `prompt.model` is required but checked at run start, not load
  (§4.2), because config has no per-key required declaration. Letting a type declare a config key
  required is [#320](https://github.com/howardyang2009/PATH/issues/320)'s to design; `prompt.model` is
  its first named case.
- **`prompt`'s `cli` and `remote` workers.** #309's model names them; only `sdk` is built. Each is
  addable later as a second worker in the `prompt` folder with **no format change** — the `worker` enum
  simply widens.
- **Whether `else` should become mandatory.** mvp-spec §5.2 fails a no-match-with-no-`else` run. A
  single-node `else` is cheap, so the argument may reopen. Not decided by `@3`.
- **Any other v-next door.** `@3` carries this worker-name change only. Additive doors keep their own
  triggers.
- **Everything about a step-type plugin except the two sentences §1 and §4 add.** How the registry is
  built and frozen is ADR 0018; where a plugin lives and what it consists of is ADR 0019; how discovery
  reports a file whose plugin is absent is [server-api-v0.md §6](../api/server-api-v0.md); a plugin's
  own version is #324. This document fixes only that `format` does not move when the type set does.

## 12. Authoring & navigation

Hierarchical workflows are authored as plain JSON files, hand-edited, composed by relative-path `ref`s,
and navigated as a file tree. There is no dedicated authoring surface in the MVP. Strict ids and
load-time whole-tree validation are what keep hand-authoring honest.
