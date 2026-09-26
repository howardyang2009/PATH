# PATH Workflow File Format

This is the normative definition of `path/workflow@5`, the one format the engine reads. `@path/schema`
implements it as zod schemas. The engine executes it. The vocabulary follows
[CONTEXT.md](../../CONTEXT.md) (step, worker, task, run, controller, checkpoint, config vs context,
output object, publish, first level, pass).

It is **self-contained**: everything needed to author, validate, or interpret a `@5` file is stated
here. Superseded formats (`@0`–`@4`) are kept for the record under [`archive/`](archive/); §11 states
what changed since `@4` and how to migrate an old file. Where this document and an
[ADR](../adr/README.md) disagree, the ADR wins on *why* and this document wins on *what the code does*.
`goto`'s execution model — passes, resume, Complete, and audit events — is specified normatively in
[`docs/spec/goto.md`](../spec/goto.md); §6.2 here fixes only its file grammar.

## 1. File & envelope

- A workflow file is a single **JSON** document (UTF-8). JSON is the only syntax.
- Recommended file naming: `<name>.workflow.json`.
- Every file declares `"format": "path/workflow@5"`. This is identity and version in one required
  string, **exact-match validated**. An engine that does not speak the declared version **fails at
  load**.
- **The declared version does not track the set of step types.** `format` fixes the *grammar shape* —
  the container rules, the envelope, the common step fields — and it keys the codemod chain (§11). The
  set of valid **leaf step types** is a fact about the **step-plugin registry** the engine loaded, not
  about the format (§4). A file that uses a plugin-contributed step type is a `@5` file and stays one:
  a plugin type needs no codemod, because there is no earlier *shape* to lift such a file from. The
  thing it lacks on a given machine is a plugin folder, and the fix is to add one, not to run a script.
  (#315.)
- Validation is **strict**: unknown fields anywhere are rejected.
- **A superseded format is rejected at load** with a targeted message that names the whole codemod
  chain, in the order the scripts must run, per the ADR 0007 precedent. It is never a generic zod
  "invalid literal" on `format`:

  ```
  path/workflow@4 is no longer read — run scripts/migrate-workflow-format-v5.ts to migrate this file to path/workflow@5
  ```

  The engine reads `@5` only. There is no dual reader. Each codemod migrates exactly one step and skips
  anything else silently, so a file more than one version behind names every script it needs; handed an
  `@0` file, the `@5` script reports "skipped" and leaves it untouched, so to name it alone would name
  a fix that is not one.
- **A newer version** gets a symmetric pre-check. A well-formed `path/workflow@<n>` with `n` greater
  than the engine's own version gets:

  ```
  path/workflow@6 is newer than this engine reads (path/workflow@5) — upgrade PATH to read it
  ```

  rather than a bare invalid-literal. A malformed version string (a trailing space, a non-numeric or
  zero-padded version, a different prefix) still falls through to the literal mismatch.

Step-Templates and Workflow-Templates stamp the same `FORMAT_VERSION` (ADR 0048 §1), so they read
`path/workflow@5` too.

## 2. Top-level workflow object

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Exactly `"path/workflow@5"`. |
| `id` | yes | Durable GUID (UUIDv4) — the stable machine identity (§3). |
| `name` | yes | Workflow name, pattern `^[a-z][a-z0-9-]*$`. |
| `config` | no | The file's config defaults (§7). |
| `input` | no | The file's default root launch seed (§2.1). |
| `worker_defaults` | no | The file's worker-default table (§2.2). |
| `body` | yes | Non-empty **array of nodes** (§4). |
| `output` | no | Interpolation map defining the workflow's output object (§6.4). Absent = `{}`. |

There is **no file-level `worker`** (`@2` had one, required). A worker is a per-step selection now
(§4.1); shared data such as `model` travels through `config` (§7).

**The file's `body` is the file's outermost sequence.** The top level is the one place besides a
`sequence` node that holds a node array. It is a node sequence with the same semantics: nodes run in
order, each node's default input is its predecessor's output object (§6.1), and the file's output is
built from `output` at the end (§6.4). Rather than mint a `sequence` node to wrap the whole file, the
file simply *is* its own outermost sequence. This is a spec rule, not an inference. (Rejected: a single
top-level `node` field, because it would force a minted `sequence` name into every multi-node file; and
a merge of the envelope with a `sequence` node, because it would put one `id` on both the run-bearing
implicit root and a run-less controller.)

There is **no input declaration**: the input object arrives at runtime, and `input` (§2.1) is only the
file's default for it.

### 2.1 `input`

`input` is an **optional** JSON object: the file's own default seed for the root run's context. Its
top-level keys become the root context, exactly as a launch's `input` field does (§6.3).

```jsonc
{
  "input": { "ticket": 7, "labels": ["from-file"] }
}
```

It is **plain JSON data** — no `${…}` interpolation and no `$secret`/`$env` wrappers. Nothing resolves
the root seed before it lands in context, so a placeholder here would survive as literal text; the load
rejects one. It is a JSON **object**, never an array or a scalar, because its top-level keys are what
seed context.

Precedence at launch: an operator **input override** with at least one top-level key wins; a blank
field, a literal `{}`, or an omitted field falls back to this file seed; a file with no `input` falls
back to `{}`. The resolved value is what the run records.

It seeds the **root run only**. A nested `workflow`-ref run's context comes from its parent step's
`input`, never from the child file's own `input`.

### 2.2 `worker_defaults`

`worker_defaults` is an **optional** `{ <stepType>: <workerName> }` map. It **selects**, per step type,
which worker that type's *un-pinned* steps run on in this file — a name chosen among the workers the
type already ships, never new code (ADR 0044, CONTEXT.md invariant 5).

Resolution order for a leaf step's worker, first hit wins:

```
node.worker  >  launch worker-default  >  file worker_defaults[type]  >  plugin defaultWorker
```

- A step that names its own `worker` still wins — `worker_defaults` never overrides an explicit pin.
- A step of a type absent from the table falls back to the type's `defaultWorker`, unchanged.
- The **launch** tier sits between them: the operator's run-wide table (CLI `--worker-default <type>=<name>`,
  or a top-level `worker_defaults` on `POST /v0/runs`) reaches every un-pinned step of every file in the
  run, so it outranks even a *child* file's own table.

It is **file-scoped**: it never crosses a `workflow`-ref boundary. A parent file's table does not reach
a child ref file's steps, and each ref file authors its own. It is **live**, not frozen: a resumed run
re-reads the current file, so an edit between launch and resume changes only re-run steps. (The launch
tier is frozen with the run, ADR 0046; the file table is not.)

Its registry-relative validity (a real type shipping that worker) is checked at engine load, not by the
base file schema, which stays shape-only (`{ <string>: <string> }`).

## 3. Conventions

- **Discriminator.** Every tagged union in the format discriminates on a single field named `type`:
  nodes and conditions alike (a worker is a plain name now, not a tagged union — §4.1). There is no
  second-level tag. Step kinds and controllers form
  **one flat node union**. Behaviour depends on `type`, never on the presence or absence of a field.
- **Identity — `id` + `name`.** The workflow and **every node** carry two identifiers. `id` is a
  durable **GUID** (UUIDv4): the stable machine identity, assigned once by the codemod and never
  regenerated. It is the reuse/resume key and the `node_id` that a run row and log event carry. `name`
  is the human label, pattern `^[a-z][a-z0-9-]*$`, **unique across the whole file** (all nesting
  levels). It keys `collect`/`wait-one` output objects, it is what the log stream narrates, and it is
  what error messages name.

  Because every container slot holds a node, **`id` and `name` are free and required on every slot
  occupant**, including a `parallel` branch, an arm's node, an `else`, and a `while-do` body. There is
  no wrapper that carries a name that is "not a node's name." `@1`'s branch-wrapper name (which in `@1`
  had no `id` at all) is gone, and with it the branch-arm identity problem. An arm is `{ when, node }`,
  and the node carries its own `id` and `name`.
- **The step-vs-controller distinction** (only steps have workers, tasks, and runs) is a domain rule
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
| `person-activity` | step | `description`, `outputSchema?`, `assignee?` |
| `workflow` | step | `ref` |
| `parallel` | controller | `join`, `branches` |
| `branch` | controller | `arms`, `else?` |
| `while-do` | controller | `condition`, `max_iterations`, `node` |
| `sequence` | controller | `body` |
| `checkpoint` | controller | `condition` |
| `goto` | controller (graph) | `target`, `max_jumps` |

The three leaf types above — `prompt`, `binary`, `person-activity` — are the ones PATH ships today. Their
fields are plugin-declared, not format-owned; `person-activity`'s `awaiting`/Complete contract is
specified in [`docs/spec/person-activity.md`](../spec/person-activity.md).

**The union has a closed half and an open half.** **Seven** `type` values are **engine-owned and
reserved**: `workflow`, `parallel`, `branch`, `while-do`, `sequence`, `checkpoint`, and `goto`. They are
the constructs the walker evaluates itself, they hold no worker and no run (CONTEXT invariant 1), and
nothing can contribute or replace them. Every *other* `type` value is a **leaf step type**, and that
set is **open**: it is exactly what the **step-plugin registry** holds, one entry per folder under
`packages/engine/plugin/step-plugin/`. The three step rows above appear because PATH ships them, not
because the format names them — they are plugin folders like any other
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

All step types additionally accept:

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
`run` method), and `worker` selects one by name — `binary`'s `spawn`, `prompt`'s `anthropic`, each the
default of its type. A step naming a worker its type does not ship **fails at load** with the valid names
listed (the `(type, name)` pair is a worker's identity, so a name is meaningful only inside its type). A
`workflow` step takes **no `worker`**: it runs a nested run, not a worker.

Controllers (`parallel`, `branch`, `while-do`, `sequence`, `checkpoint`, `goto`) take **none** of
`worker`, `config`, `input`, `parse`, or `publish`. They have no worker, no task, and no run.

### 4.2 Step types

**`prompt`** — `prompt` (string, interpolable) is the instruction text. The step's **worker** selects the
model provider, because a provider *is* a named method that produces the step's output: this type ships
two, `anthropic` (the default, Anthropic via the Agent SDK) and `deepseek` (one OpenAI-compatible Chat
Completions request). A step naming no worker gets `anthropic`, which is what every `prompt` step written
before the second worker existed means, so `worker` is the only thing that changes when an author
switches provider. Either worker receives the prompt plus the step's entire input object, rendered, and
the **model** it runs on from `config.model` (§7); the rendered message is identical for both, so the
two answer the same question. There is no `context_refs` mechanism. What the step reads is exactly what
its `input` map builds. `config.model` is required for a `prompt` step; a step with none **fails at run
start**, not at load — config carries no per-key required declaration, so the check has no load to live
at (ADR 0021 sub-10). `config.options` is the worker's invocation bag, read per worker: `anthropic`
passes the whole bag to the Agent SDK (MCP servers, skills, system prompt, `settingSources`), while
`deepseek` honors the subset its HTTP transport can express (`systemPrompt` as a string, `maxTokens`,
`temperature`, `thinking`) and ignores the rest.

`worker` is per-step: there is **no file-level or run-level worker default** in the step itself (§4), so
putting a whole workflow on `deepseek` means naming that worker on each of its `prompt` steps, or
selecting it once in the file's `worker_defaults` table (§2.2). The `deepseek` worker's credential may
be **environment or config** — `config.DEEPSEEK_API_KEY` first (usually
`{"$secret": {"$env": "DEEPSEEK_API_KEY"}}`, or a literal `$secret` typed at launch), then
`DEEPSEEK_API_KEY` in the engine's environment as the fallback (ADR 0045) — while its endpoint is
**environment only**, `DEEPSEEK_BASE_URL` for a gateway. `anthropic` uses the Agent SDK's own
`ANTHROPIC_API_KEY` or subscription credential and ignores `config.DEEPSEEK_API_KEY`. A `deepseek` step
whose `config.model` still names a Claude model has that name mapped onto a DeepSeek model (opus →
`deepseek-v4-pro`, sonnet/haiku → `deepseek-flash`) and reports the substitution as a step diagnostic
rather than failing.

**`binary`** — `command` (string), `args` (string array, default `[]`), and `cwd` (string, default: the
directory of the workflow file), all interpolable. A **relative `cwd` resolves against the directory of
the workflow file**, the same anchor as its default. It never resolves against the directory `path run`
was invoked from, so a workflow behaves the same wherever it is launched. I/O convention:

- The input object is written to the process's **stdin**: raw bytes if it is a string, otherwise its
  JSON serialization.
- The output object is the captured **stdout** (a string, unless `parse: "json"`).
- A **non-zero exit code fails the step** (and thus the run). stderr is not data. The engine captures it
  for audit (a per-step-run `stderr.txt`), and never passes it downstream.

**`person-activity`** — `description` (string, interpolable) is the offline work the person is asked to
do; `assignee` (optional string, interpolable) names who is asked; `outputSchema` (optional JSON Schema)
constrains the output a person may submit. The step computes nothing: its `person` worker returns
`{ status: "awaiting" }`, the engine parks the leaf and tears the run down durably, and a later Complete
submits the person's output, validates it against `outputSchema` (Ajv, against the current file), and
continues the run. `awaiting` is leaf-only: a parent run stays `running` while a descendant awaits. The
full contract is [`docs/spec/person-activity.md`](../spec/person-activity.md).

**`workflow`** — `ref` (string, *not* interpolable) is a relative path to another workflow file,
resolved against the directory of the referencing file. The child run starts with a fresh context,
seeded only by its input object (§6.3). Data returns only through the child's `output` object. Config
crosses the boundary (§7), so a `config.model` set in the parent reaches the child's `prompt` steps
unless the child sets its own. A worker name never crosses: it is a per-step selection within a file.

### 4.3 Controllers

A controller routes and coordinates step execution. The engine of its enclosing workflow evaluates it. It
has no worker, no task, and no run. So no controller is ever a run row or a resume key (§5.5).

There are two kinds. The five **Structure Controllers** — `parallel`, `sequence`, `branch`, `while-do`,
`checkpoint` — shape one body. The one **Graph Controller** is `goto`: it sets the next node of the
file's top-level walk (§6.2). Adding a second graph controller needs its own ADR
([ADR 0057](../adr/0057-controllers-split-into-structure-and-graph-kinds.md) §3).

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
  and §10).

See [wait-one-join.md](../spec/wait-one-join.md) and
[do-not-wait-join.md](../spec/do-not-wait-join.md).

**`branch`** — `arms` is a non-empty array of `{ "when": <condition>, "node": <node> }`, plus an
optional top-level `else` that holds **one node**. The arms are tested in order. The first arm whose
`when` (§9) is true has its `node` taken. If none match and there is no `else`, the run fails (§5.4).
Each arm's `node` and the `else` node carry their own `id` and `name`.

**`while-do`** — `condition` (a condition, §9) is checked before each iteration. While it is true, the
block's single `node` runs. `max_iterations` is a positive integer, or an interpolable string that
resolves to one. It is **required**. To exceed it fails the run. The body is one `node`. Each iteration
is its own worker-less run scope, so a `while-do` body's runs are told apart per iteration (ADR 0037).

**`sequence`** — see §4.4.

**`checkpoint`** — `condition` only. If it is true, the run continues. If it is false, the run stops as
failed, and that failure propagates as §5 (an ordinary run failure). It is mechanical assertions only.
Anything that needs judgment is a normal step that outputs a verdict, followed by a checkpoint that
tests it (the judge-step pattern). `checkpoint` is **unchanged** from `@1`.

**`goto`** — see §6.2.

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

`sequence` takes **none** of `worker`, `config`, `input`, `parse`, or `publish`. It is a controller, not a
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

This section fixes the runtime contracts the format implies. Nothing here is new except the single
`sequence` output clause (§4.4), which is itself the pre-existing block-slot rule, and the `goto` pass
model (§6.2).

### 5.1 A node's publish set

Several rules below quantify over "the publishes inside a branch." A branch is one node, so the scope is
defined once:

> A node's **publish set** is the set of `publish` keys declared on that node, together with the publish
> sets of every node reachable through its child bodies: through a `sequence`, a nested `branch`,
> `while-do`, or `parallel`, and any depth of nesting. It does **not** descend into a `workflow` step's
> ref'd file: that file has its own isolated context and its own load pass.

A nested inner `parallel`'s keys therefore count toward the enclosing branch node's publish set. An
inner key still lands at the inner join and propagates outward. So two sibling branches that each reach
the same key still collide.

### 5.2 Node output objects

Every step produces an output object (§6.5). Controller output objects:

- **`sequence`** — its **last child's** output object.
- **`branch`** — the taken arm's **node's** output object.
- **`while-do`** — the **node's** output object of the final executed iteration; transparent (its
  predecessor's output) at zero iterations.
- **`parallel` / `collect`** — `{ "<branch-node-name>": <the branch node's output object>, … }`.
- **`parallel` / `wait-one`** — `{ "winner": { "name": <winning branch node's name>, "output": <that
  node's output object> } }`.
- **`parallel` / `do-not-wait`** — the empty object `{}`.
- **`checkpoint`** — transparent: its predecessor's output object passes through unchanged.
- **`goto`** — its incoming output, unchanged: the jump passes its own input through to the target
  (§6.2).

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
no arm matches and no `else` is present, the run **fails**.

### 5.5 Resume, cancellation, cost

> Resume, cancellation, and cost aggregation are invariant under `@2`. Reuse keys on a node's `id`, and
> only run-producing nodes (`prompt`, `binary`, `workflow`) produce a run. `sequence`, `goto`, and every
> branch node are controllers with no run (invariant 1). So none is ever a reuse key, a cancel cause, or
> a term in a run's cost SUM. A `wait-one` race still replays to the same winner: resume orders reused
> winners by recorded completion time, then by branch declaration order, both preserved when a branch is
> a node.

The `goto` pass container is the one exception with a row of its own: it is a run of kind `pass`
(worker-less, sharing the workflow-run's context), which §6.2 and
[`docs/spec/goto.md`](../spec/goto.md) §8 govern.

### 5.6 Load-time validation

The engine loads the **whole file tree** (following `ref`s) before any step runs. It rejects:

- unknown `format` versions, including every superseded one, with the §1 targeted message; and any
  schema violation (strict zod, unknown fields rejected)
- duplicate or pattern-violating ids and names; an empty top-level `body`; an empty `sequence` `body`;
  empty `arms` or `branches`
- reference cycles between workflow files; unresolvable `ref` paths
- duplicate `publish` keys across concurrent sibling branch nodes of one `collect` `parallel` (§5.3)
- any `publish` in a `do-not-wait` branch node's publish set, caught anywhere below the block, including
  through a `sequence` or nested `collect`/`while-do`/`branch` (§5.3)
- a `goto` whose `target` names no node, an inner node, or itself, and a `goto` placed under a
  `while-do` or a `parallel` (§6.2)
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
- **A `goto` target** reads the goto's incoming output (the value the goto passed through), never its
  skipped lexical predecessor — §6.2.

### 6.2 `goto`: the file's top-level walk

`goto` is the one Graph Controller. It sets the next node of a file's **top-level walk** to a named
**first-level node** of the same file, forward (a skip) or backward (a loop). The five Structure
Controllers are unchanged. Execution is specified normatively in
[`docs/spec/goto.md`](../spec/goto.md) §3, with the ADRs 0053–0061 holding the rationale.

```json
{ "type": "goto", "id": "<guid>", "name": "retry-jump", "target": "draft", "max_jumps": 3 }
```

- The node is `.strict()`: no other key, and no step envelope (`config` / `input` / `parse` /
  `publish`). It nests no child body.
- `target` is required: a name string (`^[a-z][a-z0-9-]*$`), the **name** of the target node, never
  its `id`.
- `max_jumps` is required: a positive integer, or a string that interpolates to one over `config` +
  `context` (the `while-do` `max_iterations` grammar). There is no default.
- `goto` is the seventh reserved type name, so no step-plugin folder may claim it, and the controllers
  are six: the five Structure Controllers and `goto`, the one Graph Controller (ADR 0057).

**Placement.** A goto may sit in any node slot whose ancestor chain holds no `while-do` and no
`parallel`. That covers the first level, a first-level `branch`'s arm or `else`, and any `sequence` /
`branch` nesting below one.

**Target.** Any other first-level node of the goto's own file: a step, a `workflow` step, a controller,
or another goto. Never an inner node, and never the goto itself. "First level" is per file: a goto in a
`workflow`-ref file targets and jumps within that file only, and a child's jump never reaches its
parent.

A whole-file load (the engine, the server template store, the Designer's draft validation) refuses a
goto with one issue per offender, all in one failed parse:

| `rule` | Case | Issue at | Message |
|---|---|---|---|
| `target-absent` | `target` names no node in the file | `target` | `goto target "retry" not found in this file` |
| `target-inner` | `target` names a node that is not first-level | `target` | `goto target "check" is not a first-level node` |
| `target-self` | `target` names the goto itself | `target` | `goto "loop" targets itself` |
| `placement` | a goto under `while-do` or `parallel` | the goto node | `goto "x" may not sit under while-do "poll"` |

A Step-Template body is not checked for these, because it has no file until it lands; the instance is
checked by the target file's load. Instantiation does not rewire targets.

**Passes.** Only a file that contains a goto node has passes, decided at load whether or not a jump is
taken. A **pass** is one forward stretch of the top-level walk: from the start of the body, or from a
jump target, up to the next jump taken or the end of the body. Each pass is a worker-less container run
of kind `pass` (1-based `pass` ordinal, `nodeId` naming the goto that opened it, `null` for pass 1) that
shares the workflow-run's context. Within a pass each first-level node runs at most once.

**Seeding.** The goto's incoming output becomes the target's incoming output, and the target resolves
its input as any step does (§6.1). A revisit is a fresh run with its own recorded input; nothing
compares or reuses earlier visits. No new interpolation root exists: there is no `${goto.*}` and no
`${previous.*}`.

**Context.** All passes share the workflow-run's one blackboard, last-writer-wins. A jump neither
snapshots, rolls back, nor clears a key; reading a key no node has published on the path taken fails the
reading node with the existing interpolation error. An author seeds a loop-carried key through the
workflow's input or the launch context seed.

**Termination.** `max_jumps` is counted **per goto node, per workflow-run**, and a re-run `workflow`
step's fresh child run starts at zero. A goto reached with its jumps spent fails the pass and the
workflow-run; there is no fall-through. The authored guard is the enclosing branch arm's `when`, and
`max_jumps` is the backstop. There is no global cap: a `while-do` inside a jump loop keeps its own bound.

**Audit.** `pass-started`, `goto-taken`, and `goto-exhausted` are control events emitted by the
top-level walk; their payloads and line texts are fixed by [`docs/spec/goto.md`](../spec/goto.md) §7.

### 6.3 Workflow input seeds context

At run start, each top-level key of the workflow's input object becomes a context key. Conceptually it
is the implicit root step's one write. Nodes read it through `context.*` in interpolation and conditions.
No separate `input` root exists. The input object is the launch input override when the operator supplies
one with at least one top-level key, else the file's own `input` (§2.1), else `{}`.

### 6.4 Workflow output

The top-level `output` map (roots `config` and `context`) is evaluated at successful run end. It is the
workflow's output object: the explicit contract a parent's `publish` reads from. Absent = `{}`.

### 6.5 Output parsing

`parse: "json"` makes the engine parse a string output into a structured value before it becomes the
step's output object. For LLM output, the engine strips a surrounding markdown code fence first. If it
is unparseable, the step fails. The default `"text"` leaves the raw string. (This is why deep paths like
`context.verdict.pass` work: the judge step declares `parse: "json"`. The `valid-json` predicate remains
for strings deliberately left unparsed.)

### 6.6 Interpolation syntax

- Syntax: `${dot.path}` inside JSON strings. Escape a literal `${` as `$${`.
- **Whole-string rule.** If a string is exactly one placeholder, it resolves to the referenced value
  with its **real type** (`"max_iterations": "${config.max_revisions}"` resolves to the number).
  Otherwise the string is a **splice**: each part stringifies, and to splice a non-scalar (object or
  array) is a runtime error.
- Unresolvable paths are errors (strict).
- **Evaluated positions** (an allowlist; inert everywhere else, notably ids, `type` tags, `format`,
  `join`, `ref`, `target`, and condition trees, which have their own language):
  - step payload fields (`prompt`, `command`, `args`, `cwd`)
  - `input` values (§6.1)
  - `publish` values (§6.2) and workflow `output` values (§6.4)
  - `max_iterations` and `max_jumps`

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
becomes maskable with a `$secret` wrapper. `config.DEEPSEEK_API_KEY` is the `deepseek` worker's
credential key, read before `process.env.DEEPSEEK_API_KEY` (ADR 0045); wrap it in `$secret` or it is a
plain value the masker does not know about. Because config is literal, `model` cannot be chosen from a
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

An **operator's** override is frozen with the run (ADR 0046): recorded on the run's root row resolved
and `$secret`-masked, recovered by a Resume or a Complete. The file's own config is not frozen — it is
re-read from disk on every invocation, so an author's edit reaches a step that re-runs.

### 7.3 Value wrappers and the reserved `$` namespace

Two wrappers are the one exception to §7.1's literalness. Both are **sole-key objects** that stand where
a literal value would:

| Wrapper | Means |
| --- | --- |
| `{"$secret": "<value>"}` | Marks the value for persistence-boundary redaction. `<value>` is a **string**, or the nested `{"$env": "<NAME>"}` form below — nothing else. |
| `{"$env": "<NAME>"}` | Sources the value from environment variable `NAME` at run start. |

They **compose by nesting**, not side by side: `{"$secret": {"$env": "NAME"}}` is a value both sourced
and masked. `$env` is the source, and `$secret` is the marking laid over it. So that is the only nesting
order. Masking is by value, and "env is always secret" would scrub an env-sourced model name out of
every log event in the run; the author says which sourced values are secret.

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
field names, not wrapper positions. A config value that legitimately wants a sole `$`-prefixed key is
therefore **unexpressible**, and there is no escape hatch; one would be additive if something concrete
is ever blocked by this.

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

## 10. Deferred and owned elsewhere

- **`goto`'s execution details.** Passes, seeding, jumps spent, the three audit events, Resume,
  Complete, the Designer's contract, and the run-tree label are specified in
  [`docs/spec/goto.md`](../spec/goto.md) (ADRs 0053–0061). This document fixes the file grammar only.
- **A required-config-key mechanism.** `prompt.model` is required but checked at run start, not load
  (§4.2), because config has no per-key required declaration. Letting a type declare a config key
  required is [#320](https://github.com/howardyang2009/PATH/issues/320)'s to design; `prompt.model` is
  its first named case.
- **`prompt`'s other workers.** Each future provider is a second worker in the `prompt` folder with
  **no format change** — the worker-name set simply widens.
- **Whether `else` should become mandatory.** §5.4 fails a no-match-with-no-`else` run. A single-node
  `else` is cheap, so the argument may reopen.
- **Everything about a step-type plugin except the two sentences §1 and §4 add.** How the registry is
  built and frozen is ADR 0018; where a plugin lives and what it consists of is ADR 0019; how discovery
  reports a file whose plugin is absent is [server-api-v0.md §6](../api/server-api-v0.md).

## 11. Changes since `@4` and migration

`@5` adds one grammar change: the seventh reserved member, `goto` (§6.2), because an engine that reads
`@4` does not know the type, and a file that may carry one must say so in `format` where an older engine
refuses it legibly (§1) rather than at an unknown node deep in the body. The envelope does not change: a
goto-free `@4` file is already a valid `@5` file once its `format` string moves. Full superseded
formats live under [`archive/`](archive/):

| Format | File | What it is |
| --- | --- | --- |
| `@1` | [`archive/workflow-format-v0.md`](archive/workflow-format-v0.md) | The initial format (despite the `v0` filename): a worker was a tagged object, and every block slot held a `body`. |
| `@2` | [`archive/workflow-format-v2.md`](archive/workflow-format-v2.md) | Every container slot holds **one node**; `sequence` is added for the multi-node slot. |
| `@3` | [`archive/workflow-format-v3.md`](archive/workflow-format-v3.md) | A worker is a **name**, not a tagged object; `model`/`options` move to config. |
| `@4` | [`archive/workflow-format-v4.md`](archive/workflow-format-v4.md) | The file-level `worker_defaults` table and the optional file-level `input` seed. |
| `@5` | this document | The `goto` controller. |

Because `@4` and `@5` differ only by the `format` string for every file that exists today, the `@4` →
`@5` codemod is a **no-op format stamp**: it rewrites `format` to `path/workflow@5`, changes nothing
else (the file's bytes, formatting included, are carried through), refuses nothing, and is idempotent.
Run it with:

```
pnpm tsx scripts/migrate-workflow-format-v5.ts [file …]
```

With no arguments it discovers every `*.workflow.json`, `*.step-template.json` and
`*.workflow-template.json` under the current directory (skipping dot directories and `node_modules`)
and under its `.path/template/`. The engine reads `@5` only — there is no dual reader — so an older file
loads with a targeted "run the codemod" error naming its whole chain in order, ending with this script
(§1). The earlier codemods are the hard parts, and they live in
[`scripts/archive/`](../../scripts/archive): `@1`→`@2` unwraps each `parallel` branch into a node
(renaming the node to the wrapper's `name` so a `collect` key stays byte-identical), and `@2`→`@3`
deletes the old `worker` object and hoists its `model`/`options` into the owning object's `config`,
refusing rather than silently changing meaning when the old value was interpolated or the effective
worker was `engine`.

## 12. Authoring & navigation

Hierarchical workflows are authored as plain JSON files, hand-edited, composed by relative-path `ref`s,
and navigated as a file tree. The Designer (`@path/designer`) is the visual authoring surface over those
same files. Strict ids and load-time whole-tree validation are what keep hand-authoring honest.
