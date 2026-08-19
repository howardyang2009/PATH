# PATH Workflow File Format v2

The normative definition of `path/workflow@2`. `@path/schema` implements it as zod schemas; the
engine executes it. Vocabulary follows [CONTEXT.md](../../CONTEXT.md) (step, worker, task, run,
logicer, checkpoint, config vs context, output object, publish).

This document is **self-contained**: everything needed to author, validate, or interpret a
`path/workflow@2` file is stated here. It **supersedes**
[`workflow-format-v0.md`](workflow-format-v0.md), which — despite its filename — describes
`path/workflow@1`; that document is kept only because the CHANGELOG and several closed issues link
it, and it carries a superseded banner pointing here.

## 0. What `@2` is

`@2` makes one structural change to the format and nothing else: **every container slot holds exactly
one node.** A `parallel` branch is a node, a `branch` arm's occupant is a node, an `else` is a node,
a `while-do` body is a node. The `@1` branch wrapper `{ id, name, body }` — a thing that was *not*
itself a node — is gone. For the case that a slot genuinely needs several nodes in order, `@2` adds a
fourth logicer, **`sequence`** `{ type, id, name, body }`, whose `body` is a node array.

Two slots keep arrays, and only two: the **file's top-level `body`** and a **`sequence`'s `body`**.
Both are true node sequences; everywhere else, one node.

The runtime contracts are unchanged. Resume, cancellation, cost, the join output shapes, the
duplicate-publish rules, the default-input chain — all carry over from `@1` verbatim, restated below
over "a node" wherever `@1` said "a branch." The `collect` / `wait-one` output **shape is identical**;
only the *source* of the output key moved (from the deleted wrapper onto the node — §4.3). The trade
this change makes, and the alternatives weighed, are recorded in the map's ADR; this document fixes
the format.

## 1. File & envelope

- A workflow file is a single **JSON** document (UTF-8). JSON is the only syntax.
- Recommended file naming: `<name>.workflow.json`.
- Every file declares `"format": "path/workflow@2"` — identity and version in one required string,
  **exact-match validated**. An engine that does not speak the declared version **fails at load**.
- Validation is **strict**: unknown fields anywhere are rejected.
- **`@1` and `@0` files are rejected at load** with a targeted message naming the codemod, following
  the ADR 0007 precedent — never a generic zod "invalid literal" on `format`:

  ```
  path/workflow@1 is no longer read — run scripts/migrate-workflow-format-v2.ts to migrate this file to path/workflow@2
  ```

  The engine reads `@2` only; there is no dual reader. Migration is the one-time repo script
  [`scripts/migrate-workflow-format-v2.ts`](../../scripts/migrate-workflow-format-v2.ts) (§11),
  following its `@0`→`@1` predecessor `scripts/migrate-workflow-format-v1.ts`.

## 2. Top-level workflow object

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Exactly `"path/workflow@2"`. |
| `id` | yes | Durable GUID (UUIDv4) — the stable machine identity (§3). |
| `name` | yes | Workflow name, pattern `^[a-z][a-z0-9-]*$`. |
| `worker` | yes | Default worker for the file's steps (§7). Steps override atomically. |
| `config` | no | The file's config defaults (§8). |
| `body` | yes | Non-empty **array of nodes** (§4). |
| `output` | no | Interpolation map defining the workflow's output object (§6.4). Absent = `{}`. |

**The file's `body` is the file's outermost sequence.** The top level is the one place besides a
`sequence` node that holds a node array, and it is a node sequence with the same semantics: nodes run
in order, each node's default input is its predecessor's output object (§6.1), the file's output is
built from `output` at the end (§6.4). Rather than mint a `sequence` node to wrap the whole file, the
file simply *is* its own outermost sequence. This is a spec rule, not an inference. (Rejected: a
single top-level `node` field — it would force a minted `sequence` name into every multi-node file;
and merging the envelope with a `sequence` node — it would put one `id` on both the run-bearing
implicit root and a run-less logicer.)

There is **no input declaration**: the input object arrives at runtime (from the parent
workflow-step, or empty for a top-level run) and seeds the initial context (§6.3).

## 3. Conventions

- **Discriminator.** Every tagged union in the format discriminates on a single field named `type` —
  nodes, workers, and conditions alike. There is no second-level tag: step kinds and logicers form
  **one flat node union**. Behaviour depends on `type`, never on the presence or absence of a field.
- **Identity — `id` + `name`.** The workflow and **every node** carry two identifiers. `id` is a
  durable **GUID** (UUIDv4) — the stable machine identity, assigned once by the codemod and never
  regenerated; it is the reuse/resume key and the `node_id` a run row and log event carry. `name` is
  the human label, pattern `^[a-z][a-z0-9-]*$`, **unique across the whole file** (all nesting levels);
  it keys `collect`/`wait-one` output objects, is what the log stream narrates, and is what error
  messages name.

  Because every container slot now holds a node, **`id` and `name` are free and required on every
  slot occupant** — including a `parallel` branch, an arm's node, an `else`, and a `while-do` body.
  There is no wrapper carrying a name that is "not a node's name"; `@1`'s branch-wrapper name (which
  in `@1` had no `id` at all) is gone, and with it the branch-arm identity problem — an arm is now
  `{ when, node }` and the node carries its own `id` and `name`.
- **The step-vs-logicer distinction** (only steps have workers/tasks/runs) is a domain rule enforced
  by the schema, not an extra nesting level in the JSON.

### 3.1 The one naming rule

Two slot kinds, one rule, no exceptions:

- **`body` ⇒ a node array.** Two places carry it: the workflow top level (§2) and a `sequence` (§4.4).
- **`node` ⇒ a single node.** Three places carry it: a `while-do`'s `node`, a `branch` arm's `node`,
  and a `branch`'s `else`.

`parallel.branches` is **an array of nodes** — each branch *is* a node, so the array holds nodes
directly, not wrappers. Every slot obeys the rule: a slot is either a `body` (many nodes, ordered) or
a single `node`, and the field name tells you which. Where a `node` slot needs several nodes in order,
the author puts a `sequence` there.

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

Three step types, four logicers, and `checkpoint`. The logicer list grows from three to four (the
new `sequence`); `checkpoint` stays beside the logicers, not inside them. No "special node" or
"control node" taxonomy term is introduced — the taxonomy is otherwise unchanged from `@1`.

Step-type-specific fields sit **directly on the node** (no `payload` wrapper). Future step types must
choose field names that do not collide with engine-owned fields (`type`, `id`, `name`, `worker`,
`config`, `input`, `parse`, `publish`).

### 4.1 Common step fields

All three step types additionally accept:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Durable GUID (§3). |
| `name` | yes | Human label, unique across the file (§3). |
| `worker` | no | Atomic override of the inherited worker (§7). |
| `config` | no | Key-level override/extension of the inherited config (§8). |
| `input` | no | Builds the step's input object (§6.1). Absent = previous node's output object. |
| `parse` | no | `"text"` (default) or `"json"` (§6.5). |
| `publish` | no | Context writes from the step's output (§6.2). Absent = writes nothing. |

Logicers (`parallel`, `branch`, `while-do`, `sequence`) and `checkpoint` take **none** of
`worker`/`config`/`input`/`parse`/`publish` — they have no worker, no task, no run.

### 4.2 Step types

**`prompt`** — `prompt` (string, interpolable) is the instruction text. The worker (an LLM worker)
receives the prompt plus the step's entire input object, rendered. There is no `context_refs`
mechanism: what the step reads is exactly what its `input` map builds.

**`binary`** — `command` (string), `args` (string array, default `[]`), `cwd` (string, default: the
directory of the workflow file), all interpolable. A **relative `cwd` resolves against the directory
of the workflow file**, the same anchor as its default — never against the directory `path run` was
invoked from, so a workflow behaves the same wherever it is launched. I/O convention:

- The input object is written to the process's **stdin**: raw bytes if it is a string, otherwise its
  JSON serialization.
- The output object is the captured **stdout** (a string, unless `parse: "json"`).
- A **non-zero exit code fails the step** (and thus the run). stderr is not data; it is captured for
  audit (a per-step-run `stderr.txt`), never passed downstream.

**`workflow`** — `ref` (string, *not* interpolable) is a relative path to another workflow file,
resolved against the directory of the referencing file. The child run starts with a fresh context
seeded only by its input object (§6.3); data returns only through the child's `output` object. Config
crosses the boundary (§8); **worker does not** — every file declares its own (§7).

### 4.3 Logicers

A logicer routes and coordinates step execution and is evaluated by the engine of its enclosing
workflow. It has no worker, no task, no run — so no logicer is ever a run row or a resume key (§5.5).

**`parallel`** — `join` is `"collect"`, `"wait-one"`, or `"do-not-wait"`. `branches` is a
**non-empty array of nodes** (§3.1); each branch is a node carrying its own `id` and `name`.

- **`collect`** runs every branch and joins their outputs into
  `{ "<branch-node-name>": <that node's output object>, … }`. The key is the **branch node's own
  `name`**. **The output shape is unchanged from `@1`** — the same `{ name: output }` map keyed by a
  file-globally-unique name; only the *source* of the key moved, from the deleted wrapper onto the
  node. (A reader expecting the `@1` contract to have broken here will find it has not: same keys,
  same values, same shape.)
- **`wait-one`** races the branches and keeps the first to succeed, cancelling the rest; only the
  winner's publishes land, so two branches publishing one context key is allowed here (§5.3) where
  `collect` rejects it. Its output is the stable `{ "winner": { "name": <winning branch node's name>,
  "output": <that node's output> } }` shape — **unchanged from `@1`**, the winner named by its node's
  `name`.
- **`do-not-wait`** launches every branch and waits for none at the join: the block completes at once
  with output `{}`, and a branch **may not `publish`** anywhere reachable within it (rejected at load,
  §5.3 and §9).

See [wait-one-join.md](../spec/wait-one-join.md) and [do-not-wait-join.md](../spec/do-not-wait-join.md).

**`branch`** — `arms` is a non-empty array of `{ "when": <condition>, "node": <node> }`, plus an
optional top-level `else` holding **one node**. The arms are tested in order; the first whose `when`
(§10) is true has its `node` taken. If none match and there is no `else`, the run fails (§5.4). Each
arm's `node` and the `else` node carry their own `id` and `name`.

**`while-do`** — `condition` (a condition, §10) is checked before each iteration; while true, the
block's single `node` runs. `max_iterations` is a positive integer or an interpolable string
resolving to one — **required**; exceeding it fails the run. The body is one `node`.

**`sequence`** — see §4.4.

**`checkpoint`** — `condition` only: true → the run continues; false → the run stops as failed, and
that failure propagates as §5 (an ordinary run failure). Mechanical assertions only — anything
requiring judgment is a normal step that outputs a verdict, followed by a checkpoint that tests it
(the judge-step pattern). `checkpoint` is **unchanged** from `@1`.

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

`sequence` takes **none** of `worker`/`config`/`input`/`parse`/`publish`: it is a logicer, not a
step. It **adds no new execution rules** — its semantics are exactly the existing block-slot rules:

- **Output object** = its **last child's** output object.
- **Default input** — its **first child** defaults to the `sequence`'s predecessor's output object;
  later children chain internally, each defaulting to its own predecessor's output. Identical to how a
  branch arm, a parallel branch, and a loop body already default their first node (§6.1).
- **`body` minimum length is 1.** An empty `sequence` is a load error.
- **Nesting is legal** — a `sequence` may hold a `sequence`, to any depth — though it is never
  necessary (a flat `sequence` already holds any number of nodes), and the codemod never emits one.

Because a `sequence` is a node, it is a legal occupant of any single-`node` slot: a `while-do` body, a
branch arm, an `else`, or a `parallel` branch may each be a `sequence`. When a `collect` branch is a
`sequence`, the collect key is the `sequence`'s `name` and the value is the `sequence`'s output
(= its last child's output).

## 5. Execution semantics

This section fixes the runtime contracts the format implies. They are `@1`'s contracts restated over
"a node" — nothing here is new except the single `sequence` output clause (§4.4), which is itself the
pre-existing block-slot rule.

### 5.1 A node's publish set

Several rules below quantify over "the publishes inside a branch." A branch is now one node, so the
scope is defined once:

> A node's **publish set** is the set of `publish` keys declared on that node together with the
> publish sets of every node reachable through its child bodies — through a `sequence`, a nested
> `branch` / `while-do` / `parallel`, and any depth of nesting. It does **not** descend into a
> `workflow` step's ref'd file: that file has its own isolated context and its own load pass.

A nested inner `parallel`'s keys therefore count toward the enclosing branch node's publish set — an
inner key still lands at the inner join and propagates outward, so two sibling branches that each
reach the same key still collide. (This is `@1` behaviour, now stated out loud.)

### 5.2 Node output objects

Every step produces an output object (§6.5). Logicer output objects:

- **`sequence`** — its **last child's** output object.
- **`branch`** — the taken arm's **node's** output object.
- **`while-do`** — the **node's** output object of the final executed iteration; transparent (its
  predecessor's output) at zero iterations.
- **`parallel` / `collect`** — `{ "<branch-node-name>": <the branch node's output object>, … }`.
- **`parallel` / `wait-one`** — `{ "winner": { "name": <winning branch node's name>, "output":
  <that node's output object> } }`.
- **`parallel` / `do-not-wait`** — the empty object `{}`.
- **`checkpoint`** — transparent: its predecessor's output object passes through unchanged.

### 5.3 Duplicate-publish load checks

Publish keys are static strings, so publish races are detectable — and rejected — at load. Over the
publish sets (§5.1) of the branch **nodes** of a `parallel`:

- **`collect`** — a key that appears in the publish sets of **two concurrent sibling branch nodes** is
  a last-writer race and is a **load error**. (Within a single branch node the same key may appear
  more than once — e.g. two steps of its `sequence` — and does not collide with itself: they are
  sequential, deterministic last-writer, each landing before the next node.)
- **`wait-one`** — the same-key ban across sibling branch nodes is **lifted**: only the winner's
  publishes land, so two branches publishing one key is deterministic.
- **`do-not-wait`** — a branch node's publish set must be **empty**: no `publish` anywhere reachable
  within it, *including through a `sequence` or any nested block*. A non-empty publish set is a **load
  error**. The detached branch lands after its would-be readers, so any write would be a
  nondeterministic write-after-read.

### 5.4 Branch matching

`branch` arms are tested in declaration order; the first arm whose `when` condition is true is taken.
If no arm matches and no `else` is present, the run **fails**. (Whether `else` should become mandatory
is not decided by `@2`.)

### 5.5 Resume, cancellation, cost

> Resume, cancellation, and cost aggregation are invariant under `@2`. Reuse keys on a node's `id`,
> and only run-producing nodes (`prompt`, `binary`, `workflow`) produce a run; `sequence` and every
> branch node are logicers with no run (invariant 1), so none is ever a reuse key, a cancel cause, or
> a term in a run's cost SUM. A `wait-one` race still replays to the same winner: resume orders reused
> winners by recorded completion time, then by branch declaration order, both preserved when a branch
> is a node. (Build map: the `parallel` and `plan-reuse` consumers that today walk a branch wrapper's
> `body` re-target to the branch node; mechanical, no semantic change.)

### 5.6 Load-time validation

The engine loads the **whole file tree** (following `ref`s) before any step runs, and rejects:

- unknown `format` versions — including `@1`/`@0`, with the §1 targeted message; any schema violation
  (strict zod, unknown fields rejected)
- duplicate or pattern-violating ids/names; an empty top-level `body`; an empty `sequence` `body`;
  empty `arms`/`branches`
- reference cycles between workflow files; unresolvable `ref` paths
- duplicate `publish` keys across concurrent sibling branch nodes of one `collect` `parallel` (§5.3)
- any `publish` in a `do-not-wait` branch node's publish set — caught anywhere below the block,
  including through a `sequence` or nested `collect`/`while-do`/`branch` (§5.3)
- malformed `${}` syntax in interpolable positions, and `${}` roots other than the allowed ones (§6)
- malformed config wrappers, and sole `$`-prefixed config keys that name no known wrapper (§8.3)

Authoring errors surface at load, never mid-run. An **unset `$env` variable is not a load failure**
(§8.3): it fails the run at start, before the first step.

## 6. Interpolation & data flow

### 6.1 Step input

`input` is **any JSON value**, interpolated: a map is the common case, but a bare `"${context.x}"`
(whole-string rule, §6.6) makes that value the entire input object, and literals are allowed. When
`input` is absent, the step's input object is the **previous node's output object**.

**The default-input chain** threads through every slot:

- At the **top level** and inside a **`sequence`**, the first node's default input is the
  **enclosing sequence's predecessor's output** (for the very first node of a top-level run: the
  workflow's own input object); each later node defaults to its predecessor's output.
- The first node of a **block slot** — a branch arm, a `parallel` branch, a `while-do` body — defaults
  to the **block's predecessor's output object** (parallel siblings all start from that same
  snapshot).
- A **`sequence` needs no special clause**: its first child defaults to the `sequence`'s predecessor's
  output, its later children chain internally — identical to the arm / branch / loop-body rule.
- **`while-do` across iterations**: iteration 1's node reads the block's predecessor's output;
  iteration N's node reads iteration N−1's node's output.

### 6.2 Publishing to context

`publish` is a map of context-key ← interpolated value, with `output` available as a root alongside
`config`/`context`. It covers whole-object (`"${output}"`), rename, and deep-pick with the one
interpolation mechanism. A step without `publish` writes nothing to context.

### 6.3 Workflow input seeds context

At run start, each top-level key of the workflow's input object becomes a context key — conceptually
the implicit root step's one write. Nodes read it via `context.*` in interpolation and conditions; no
separate `input` root exists.

### 6.4 Workflow output

The top-level `output` map (roots `config`/`context`) is evaluated at successful run end and is the
workflow's output object — the explicit contract a parent's `publish` reads from. Absent = `{}`.

### 6.5 Output parsing

`parse: "json"` makes the engine parse a string output into a structured value before it becomes the
step's output object; for LLM output a surrounding markdown code fence is stripped first. Unparseable
→ the step fails. Default `"text"` leaves the raw string. (This is why deep paths like
`context.verdict.pass` work: the judge step declares `parse: "json"`.)

### 6.6 Interpolation syntax

- Syntax: `${dot.path}` inside JSON strings. Escape a literal `${` as `$${`.
- **Whole-string rule**: if a string is exactly one placeholder, it resolves to the referenced value
  with its **real type** (`"max_iterations": "${config.max_revisions}"` → the number). Otherwise the
  string is a **splice**: each part stringifies; splicing a non-scalar (object/array) is a runtime
  error.
- Unresolvable paths are errors (strict).
- **Evaluated positions** (allowlist — inert everywhere else, notably ids, `type` tags, `format`,
  `join`, `ref`, and condition trees, which have their own language):
  - step payload fields (`prompt`, `command`, `args`, `cwd`)
  - `input` values (§6.1)
  - `publish` values (§6.2) and workflow `output` values (§6.4)
  - `worker` declaration values
  - `max_iterations`
- **Roots**: `config` and `context`. In `publish` maps only, the additional root `output` — the
  step's own output object. Bare roots are valid (`"${output}"`, `"${context}"`). Paths are plain
  dot-paths (numeric segments index arrays; no wildcards).

## 7. Worker declaration

Tagged on `type`:

- `{ "type": "engine" }` — the local engine executes the step (binary steps).
- `{ "type": "llm", "model": <string>, "options": { … } }` — the Agent SDK worker; `model` required;
  `options` is the named bag for SDK invocation options (MCP servers, skills, system prompt).

`worker` is **required at workflow level** and inherited by the file's steps. A step-level `worker`
**replaces the inherited one wholly** (atomic — no field merge). Worker does **not** cross the
nested-file boundary: each file's contract is self-contained. Worker values are interpolable (e.g.
`"model": "${config.model}"`).

## 8. Config

### 8.1 Literal values

Config is a JSON object of **literal values** — no interpolation inside config; it is a source, not a
consumer. A `${...}` string in config is that string, never a reference. The **one bounded exception**
is the sole-key `$` wrapper (§8.3).

### 8.2 Composition

Composition is a **shallow merge per top-level key, nearest wins**:

```
step config  >  enclosing workflow's effective config  >  file's own config (defaults)
```

Operator launch-time values (CLI flags/file) override the top-level file's defaults the same way. At
a workflow-step boundary the parent's effective config flows into the child file and shadows the
child's declared defaults key by key — context is isolated; config deliberately is not. Steps never
write config.

### 8.3 Value wrappers and the reserved `$` namespace

Two wrappers are the one exception to §8.1's literalness. Both are **sole-key objects** standing where
a literal value would:

| Wrapper | Means |
| --- | --- |
| `{"$secret": "<value>"}` | Marks the value for persistence-boundary redaction. |
| `{"$env": "<NAME>"}` | Sources the value from environment variable `NAME` at run start. |

They **compose by nesting**, not side by side: `{"$secret": {"$env": "NAME"}}` is a value both sourced
and masked. `$env` is the source and `$secret` the marking laid over it, so that is the only nesting
order.

A wrapper may sit **at any depth** inside a config value — inside objects and arrays alike — not only
at the value a dot-path lands on. `${config}` and `${config.nested}` resolve to whole sub-trees, and a
wrapper declared anywhere inside one still means what it means.

**When `$env` is read.** Every `$env` in a run's config is resolved once at run start, before anything
is persisted. Unset variables **fail the run** — in one failure naming **every** missing variable
rather than the first, before the first step runs; the run is still recorded (starts, ends `failed`,
error names the missing variables and their config keys). The **whole tree is checked**, so a nested
file's `{"$env": "KEY"}` requires that variable even when a parent's config shadows the key. **Empty
counts as set** — only an absent name is unset. The **environment is read once per run**.

**Sole key, or it is not a wrapper.** The marker must be the object's only key: `{"$secret": "x",
"note": "y"}` is an ordinary config object with a `$secret` field, not a marking.

**The `$`-sole-key namespace is reserved.** A sole-key object whose key begins with `$` and is not a
known wrapper **fails at load**, naming the key and listing what is known:

```
config.token: "$evn" is a reserved key — a sole "$"-prefixed key names a config wrapper (known: "$secret", "$env")
```

Config is a free-form key/value map, so §1's strict unknown-field rejection cannot reach inside it;
the reservation is what prevents a misspelled `{"$evn": "TOKEN"}` from silently reaching a worker as
data. Multi-key objects (`{"$foo": 1, "bar": 2}`) are plain config objects; a config object's own
keys are field names, not wrapper positions.

## 9. Do-not-wait publish ban

A `do-not-wait` branch node's publish set (§5.1) must be empty. A detached branch lands after its
would-be readers, so a `publish` from it is a nondeterministic write-after-read; it is a **load
error**, caught anywhere below the block — including one nested through a `sequence` or inside a
`collect`/`while-do`/`branch` within the detached branch. See
[do-not-wait-join.md](../spec/do-not-wait-join.md) §4.

## 10. Conditions

Zod-validated structured predicate trees, discriminated on `type`. Predicates `exists`, `equals`,
`one-of`, `matches`, `range`, `valid-json`; combinators `all`/`any`/`not`; dot-paths over roots
`context` and `output`; strict error semantics. Interpolation is never evaluated inside condition
trees. Conditions appear on `branch` arm `when`s, `while-do` `condition`, and `checkpoint`
`condition`.

## 11. Migration from `@1`

`@1` files are migrated by the one-time repo script
[`scripts/migrate-workflow-format-v2.ts`](../../scripts/migrate-workflow-format-v2.ts), following its
`@0`→`@1` predecessor. It is a committed repo-internal script, not a shipped `path migrate` command:
pre-1.0 there are no external stored workflow files.

**What the codemod does.** Proven against all 30 `*.workflow.json` in this repo — 30/30 migrated, 0
refused, idempotent (a file already at `@2` is left untouched):

- Bumps `format` to `path/workflow@2`.
- Unwraps each `parallel` branch: the `@1` wrapper `{ id, name, body }` becomes the branch's single
  node directly in `branches`. A multi-node wrapper `body` would become a minted `sequence` — but
  **across the repo every branch wrapper held exactly one node, so 0 `sequence` nodes are emitted and
  0 names are minted**.
- **Preserves the `collect` key.** In `@1` the collect key was the wrapper's `name`; in `@2` it is the
  branch **node's** `name`. Across the repo these **differ in 10 of 10** branches, so unwrapping
  naively would silently feed a downstream stdin consumer the wrong keys. The codemod therefore
  **renames the unwrapped node to the branch wrapper's `name`** (10 renames, 0 collisions), keeping the
  emitted `collect` output byte-identical.

**What the codemod refuses.** It **refuses on a name collision** rather than inventing one: if
renaming an unwrapped node to its wrapper's `name` would clash with an existing file-global name, the
codemod stops and reports the file rather than minting a disambiguated name. (No such collision occurs
across the repo's 30 files.)

The inline `.ts` test fixtures — the larger population, and missed by a `*.workflow.json` glob — are
migrated by the build map, not this script; a `*.workflow.json` codemod does not size that work.

## 12. Deferred and owned elsewhere

- **The build map** owns schema, engine dispatch, the `node-walk` rewrite, load-error message text,
  the codemod implementation, and migrating the 30 files and their tests. This document freezes the
  contract they must meet, not the code.
- **Canvas visibility of `sequence`** (whether a design surface shows a `sequence` as its own
  drill-down level or collapses it) is the Designer map's call; `@2` freezes only the *file* contract.
- **Whether `else` should become mandatory** — mvp-spec §5.2 fails a no-match-with-no-`else` run; a
  single-node `else` is cheap, so the argument may reopen. Not decided by `@2`.
- **Any other v-next door** — `@2` carries this container change only; additive doors keep their own
  triggers.
- **`checkpoint` failure semantics** (an early-return or graceful-stop terminal state) — a different
  door.

## 13. Authoring & navigation

Hierarchical workflows are authored as plain JSON files, hand-edited, composed by relative-path
`ref`s and navigated as a file tree — no dedicated authoring surface in the MVP. Strict ids and
load-time whole-tree validation are what keep hand-authoring honest.
