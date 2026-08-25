# PATH Workflow File Format v0

> [!warning] Superseded
> This document describes `path/workflow@1` (despite its `v0` filename). It is **superseded by**
> [`workflow-format-v2.md`](workflow-format-v2.md), the normative definition of `path/workflow@2`. The
> engine reads `@2` only. It rejects `@1` and `@0` files at load (run
> [`scripts/migrate-workflow-format-v2.ts`](../../scripts/migrate-workflow-format-v2.ts)). This file is
> kept because the CHANGELOG and several closed issues link it.

This spec resolves wayfinder ticket [#10](https://github.com/howardyang2009/PATH/issues/10). This
document is the normative definition of the v0 workflow file format. `@path/schema` implements it as zod
schemas. The vocabulary follows [CONTEXT.md](../../CONTEXT.md). Ticket #11 owns the runtime semantics
(scheduling, when context writes land, branch-arm matching, collect output shape, condition timing).
This document fixes the *shape* of the format and the data-flow contracts it implies.

Worked example: the acceptance pipeline in [docs/acceptance-workflow/](../acceptance-workflow/) is
written in this format.

## 1. File & envelope

- A workflow file is a single **JSON** document (UTF-8). JSON is the only syntax in v0.
- Recommended file naming: `<name>.workflow.json`.
- Every file declares `"format": "path/workflow@1"`. This is identity and version in one required
  string, exact-match validated. An engine that does not speak the declared version **fails at load**.
  There are no format migrations pre-1.0 (this mirrors the persistence decision). A file that still
  carries the pre-identity `"path/workflow@0"` is rejected with a targeted message that names the
  codemod (ADR 0007).
- Validation is **strict**: unknown fields anywhere are rejected.

## 2. Top-level workflow object

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Exactly `"path/workflow@1"`. |
| `id` | yes | Durable GUID (UUIDv4) — the stable machine identity (§3, ADR 0006). |
| `name` | yes | Workflow name, pattern `^[a-z][a-z0-9-]*$`. |
| `worker` | yes | Default worker for the file's steps (§7). Steps override atomically. |
| `config` | no | The file's config defaults (§8). |
| `body` | yes | Non-empty array of nodes (§4). |
| `output` | no | Interpolation map defining the workflow's output object (§6.4). Absent = `{}`. |

v0 has **no input declaration**. The input object arrives at runtime (from the parent workflow-step, or
empty for a top-level run) and seeds the initial context (§6.3). To declare and validate expected input
keys is a possible additive extension.

## 3. Conventions

- **Discriminator.** Every tagged union in the format discriminates on a single field named `type`:
  body nodes, workers, and conditions alike. There is no second-level tag. Step kinds and control
  constructs form **one flat node union**.
- **Identity — `id` + `name`** (ADR 0006/0007). The workflow, every body node (steps, blocks,
  checkpoints), and every parallel branch carry two identifiers. `id` is a durable **GUID** (UUIDv4):
  the stable machine identity, assigned once by the codemod and never regenerated. It is the
  reuse/resume key and the `node_id` that a run row and log event carry. `name` is the human label,
  pattern `^[a-z][a-z0-9-]*$`, **unique across the whole file** (all nesting levels). It keys
  `collect`/`wait-one` output objects, it is what the log stream narrates, and it is what error messages
  name. Parallel branch names share the same pattern and the same uniqueness scope.
- The step-vs-control distinction (only steps have workers, tasks, and runs) remains a domain rule
  enforced by the schema, not an extra nesting level in the JSON.

## 4. Node union

`body` elements are nodes. `type` is one of:

| `type` | Kind | Node-specific fields |
| --- | --- | --- |
| `prompt` | step | `prompt` |
| `binary` | step | `command`, `args?`, `cwd?` |
| `workflow` | step | `ref` |
| `parallel` | control | `join`, `branches` |
| `branch` | control | `arms`, `else?` |
| `while-do` | control | `condition`, `max_iterations`, `body` |
| `checkpoint` | control | `condition` |

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

Control nodes take **none** of `worker`, `config`, `input`, `parse`, or `publish`. They have no worker,
no task, and no run.

### 4.2 Step types

**`prompt`** — `prompt` (string, interpolable) is the instruction text. The worker (an LLM worker)
receives the prompt plus the step's entire input object, rendered. There is no `context_refs` mechanism.
What the step reads is exactly what its `input` map builds.

**`binary`** — `command` (string), `args` (string array, default `[]`), and `cwd` (string, default: the
directory of the workflow file), all interpolable. A **relative `cwd` resolves against the directory of
the workflow file**, the same anchor as its default. It never resolves against the directory `path run`
was invoked from, so a workflow behaves the same wherever it is launched. I/O convention:

- The input object is written to the process's **stdin**: raw bytes if it is a string, otherwise its
  JSON serialization.
- The output object is the captured **stdout** (a string, unless `parse: "json"`).
- A **non-zero exit code fails the step** (and thus the run). stderr is not data. The engine captures it
  for audit (a per-step-run `stderr.txt`, see the MVP spec's persistence section), and never passes it
  downstream.

**`workflow`** — `ref` (string, *not* interpolable) is a relative path to another workflow file,
resolved against the directory of the referencing file. The child run starts with a fresh context,
seeded only by its input object (§6.3). Data returns only through the child's `output` object. Config
crosses the boundary (§8). **Worker does not**; every file declares its own (§7).

### 4.3 Control nodes

Every slot a block owns holds a **body** (a non-empty node array). This is one nesting rule everywhere;
a multi-step branch never forces a nested file.

**`parallel`** — `join` is `"collect"`, `"wait-one"`, or `"do-not-wait"`. `branches` is a non-empty
array of `{ "id", "name", "body" }` (GUID plus human name, §3). The `name` labels the branch for logs
and gives `collect` a stable output key: `collect` outputs `{ "<branch-name>": <output> }`. `wait-one`
**races** the branches and keeps the first to succeed, and cancels the rest. Only the winner's publishes
land, so two branches that publish one context key are allowed there (§4.1), where `collect` rejects it.
Its output is the stable `{ "winner": { "name", "output" } }` shape (§3), the winner named by its human
`name`. `do-not-wait` **launches every branch and waits for none at the join**. The block completes at
once with output `{}`, and a branch **may not `publish`** (rejected at load, §10). See
[wait-one-join.md](../spec/wait-one-join.md) and [do-not-wait-join.md](../spec/do-not-wait-join.md). The
join execution semantics are #11's.

**`branch`** — `arms` is a non-empty array of `{ "when": <condition>, "body" }`, plus an optional
top-level `else` body. Arm ordering and matching semantics, and whether `else` is mandatory, are #11's.

**`while-do`** — `condition` (a condition, §9) sits on the block. Evaluation timing is #11's (the
acceptance pipeline requires check-before-each-iteration). `max_iterations` is a positive integer, or an
interpolable string that resolves to one. It is **required**, per the MVP logicer decision. To exceed it
fails the run. `body` as above.

**`checkpoint`** — `condition` only. If it is true, continue. If it is false, the run stops as failed.
It is mechanical assertions only (judge-step pattern for anything that needs judgment).

## 5. Interpolation

- Syntax: `${dot.path}` inside JSON strings. Escape a literal `${` as `$${`.
- **Whole-string rule.** If a string is exactly one placeholder, it resolves to the referenced value
  with its **real type** (`"max_iterations": "${config.max_revisions}"` resolves to the number).
  Otherwise the string is a **splice**: each part stringifies, and to splice a non-scalar (object or
  array) is a runtime error.
- Unresolvable paths are errors (strict, matching the condition language).
- **Evaluated positions** (an allowlist; inert everywhere else, notably ids, `type` tags, `format`,
  `join`, `ref`, and condition trees, which have their own language):
  - step payload fields (`prompt`, `command`, `args`, `cwd`)
  - `input` values (§6.1)
  - `publish` values (§6.2) and workflow `output` values (§6.4)
  - `worker` declaration values
  - `max_iterations`
- **Roots**: `config` and `context`. In `publish` maps only, the additional root `output` (the step's
  own output object). Bare roots are valid (`"${output}"`, `"${context}"`). Paths are plain dot-paths
  per the condition-language rules (numeric segments index arrays; no wildcards).

## 6. Data flow

### 6.1 Step input

`input` is **any JSON value**, interpolated. A map is the common case. But a bare `"${context.x}"`
(whole-string rule) makes that value the entire input object, and literals are allowed. When `input` is
absent, the step's input object is the **previous node's output object** (for the first body node, the
workflow's own input object). Inside block slots (branch arms, parallel branches, loop bodies) the
default-input chain threads through the block. The chain rule, like the output shapes of control nodes,
is owned by the engine execution semantics (MVP spec §5.4).

### 6.2 Publishing to context

`publish` is a map of context-key from an interpolated value, with `output` available as a root
alongside `config` and `context`. It covers whole-object (`"${output}"`), rename, and deep-pick with the
one interpolation mechanism. A step without `publish` writes nothing to context. *When* the write lands
is #11's.

### 6.3 Workflow input seeds context

At run start, each top-level key of the workflow's input object becomes a context key. Conceptually it
is the implicit root step's one write. Body nodes read it via `context.*` in interpolation and
conditions. No separate `input` root exists.

### 6.4 Workflow output

The top-level `output` map (roots `config` and `context`) is evaluated at successful run end. It is the
workflow's output object: the explicit contract a parent's `publish` reads from. Absent = `{}`.

### 6.5 Output parsing

`parse: "json"` makes the engine parse a string output into a structured value before it becomes the
step's output object. For LLM output, the engine strips a surrounding markdown code fence first. If it
is unparseable, the step fails. The default `"text"` leaves the raw string. (This is why deep paths like
`context.verdict.pass` work: the judge step declares `parse: "json"`. The `valid-json` predicate remains
for strings deliberately left unparsed.)

## 7. Worker declaration

Tagged on `type`:

- `{ "type": "engine" }` — the local engine executes the step (binary steps).
- `{ "type": "llm", "model": <string>, "options": { … } }` — the Agent SDK worker (per the LLM-worker
  decision). `model` is required. `options` is the named bag for SDK invocation options (MCP servers,
  skills, system prompt; the engine spec pins the exact keys against the pinned SDK version).

`worker` is **required at workflow level** and inherited by the file's steps. A step-level `worker`
**replaces the inherited one wholly** (atomic, no field merge). Worker does **not** cross the
nested-file boundary: each file's contract is self-contained. Worker values are interpolable (for
example, `"model": "${config.model}"`).

## 8. Config

### 8.1 Literal values

Config is a JSON object of **literal values**. There is no interpolation inside config; it is a source,
not a consumer. A `${...}` string in config is that string, never a reference.

**One bounded exception, and it is named.** A value may be a sole-key `$` **wrapper** (§8.3):
`{"$secret": …}` marks a value for redaction, `{"$env": "NAME"}` sources one from the environment, and
they compose one way round: `{"$secret": {"$env": "NAME"}}`. Nothing else in config is indirect. No
other key means anything, and a sole `$`-prefixed key that names no known wrapper is a **load error**
rather than data (§8.3, §10). The format version did not move for the wrappers. A file that carries them
is at the current `path/workflow@1`.

### 8.2 Composition

Composition is a **shallow merge per top-level key, nearest wins**:

```
step config  >  enclosing workflow's effective config  >  file's own config (defaults)
```

Operator launch-time values (CLI flags or file) override the top-level file's defaults the same way. At
a workflow-step boundary, the parent's effective config flows into the child file and shadows the
child's declared defaults key by key. Context is isolated; config deliberately is not. Steps never write
config.

### 8.3 Value wrappers and the reserved `$` namespace

Two wrappers are the one exception to §8.1's literalness. Both are **sole-key objects** that stand where
a literal value would:

| Wrapper | Means |
| --- | --- |
| `{"$secret": "<value>"}` | Marks the value for persistence-boundary redaction (mvp-spec §8.3). |
| `{"$env": "<NAME>"}` | Sources the value from environment variable `NAME` at run start. |

They **compose by nesting**, not side by side: `{"$secret": {"$env": "NAME"}}` is a value that is both
sourced and masked. `$env` is the source, and `$secret` is the marking laid over it. So that is the only
nesting order. Masking is by value, and "env is always secret" would scrub an env-sourced model name out
of every log event in the run. The author says which sourced values are secret.

A wrapper may sit **at any depth** inside a config value, inside objects and arrays alike, not only at
the value a dot-path lands on. `${config}` and `${config.nested}` resolve to whole sub-trees, and a
wrapper declared anywhere inside one still means what it means.

**When `$env` is read, and what an unset variable does.** The engine resolves every `$env` in a run's
config once at run start, before anything is persisted. Masking is by value, so a `{"$secret": {"$env":
"NAME"}}` collected before resolution would scrub the *name* and let the credential through. The
resolved value is what a worker receives and what the masker redacts.

- **Unset variables fail the run.** One failure names **every** one of them rather than the first,
  before the first step runs. The run is still recorded: it starts, ends `failed`, and its error says
  which variables were missing and under which config keys.
- **The whole tree is checked**, every file loaded with the root included. So a nested file that
  declares `{"$env": "OPENAI_KEY"}` requires that variable **even when a parent's config shadows the
  key** and the declaration can never be read. This is accepted deliberately: a run that starts and dies
  at step 14 for a variable that was already missing at step 1 is worse.
- **Empty counts as set.** `FOO=` exports an empty value, and only an absent name is unset. The engine
  cannot know whether an empty value is meaningful. An empty `$secret` still trips mvp-spec §8.3's
  short-secret warning, which fires on env-sourced values like any other.
- **The environment is read once per run**, so a variable changed mid-run cannot make two steps
  disagree about the same wrapper.

**Sole key, or it is not a wrapper.** The marker must be the object's only key: `{"$secret": "x", "note":
"y"}` is an ordinary config object that happens to have a `$secret` field, not a marking. Otherwise an
author's ordinary object would silently become a wrapper the moment it grew a field with that name.

**The `$`-sole-key namespace is reserved.** A sole-key object whose key begins with `$` and is not a
known wrapper **fails at load**. It names the key and lists what is known:

```
config.token: "$evn" is a reserved key — a sole "$"-prefixed key names a config wrapper (known: "$secret", "$env")
```

Config is a free-form key/value map, so §1's strict unknown-field rejection cannot reach inside it.
Without the reservation, a misspelled `{"$evn": "TOKEN"}` would validate as an ordinary object, and the
worker would receive the *wrapper*: a variable name leaked into an artifact, a credential missing from a
step, silently. The reservation is also what keeps a future sourcing wrapper additive rather than
ambiguous.

Two boundaries follow from the sole-key rule, and they are deliberate:

- **Multi-key objects are untouched.** `{"$foo": 1, "bar": 2}` is a plain config object.
- **A config object's own keys are field names, not wrapper positions.** `"config": {"$evn": "TOKEN"}`
  declares a config field awkwardly named `$evn`. To reserve there would make a one-field config mean
  something different from a two-field one.

The cost is stated rather than papered over: a config value that legitimately wants a sole `$`-prefixed
key is **unexpressible** in v0, and there is no escape hatch. One would be additive if something concrete
is ever blocked by this.

## 9. Conditions

As decided in ticket #7: zod-validated structured predicate trees, discriminated on `type` (which
settles the field name #7 deferred here). Predicates: `exists`, `equals`, `one-of`, `matches`, `range`,
`valid-json`. Combinators: `all`/`any`/`not`. Dot-paths over roots `context` and `output`. Error
semantics are strict. Interpolation is never evaluated inside condition trees.

## 10. Load-time validation

The engine loads the **whole file tree** (following `ref`s) before any step runs. It rejects:

- unknown `format` versions; any schema violation (strict zod, unknown fields rejected)
- duplicate or pattern-violating ids and names; empty bodies
- reference cycles between workflow files; unresolvable `ref` paths
- duplicate `publish` keys across sibling branches of one `collect` `parallel` block (per the execution
  semantics: publish keys are static, so the race is detectable, and rejected, at load). A `wait-one`
  block is exempt: only the winner's publishes land, so the same key across branches is deterministic
  ([wait-one-join.md](../spec/wait-one-join.md) §4.1)
- **any `publish` inside a `do-not-wait` branch.** A detached branch lands after its would-be readers,
  so a `publish` from it is a nondeterministic write-after-read. It is a load error, not a silent
  runtime drop, and it is caught **anywhere** below the block, including one nested in a
  `collect`/`while-do`/`branch` inside the detached branch
  ([do-not-wait-join.md](../spec/do-not-wait-join.md) §4)
- malformed `${}` syntax in interpolable positions, and `${}` roots other than the allowed ones
- malformed config wrappers, and sole `$`-prefixed config keys that name no known wrapper (§8.3)

Authoring errors surface at load, never mid-run. (Path *resolvability* against runtime data is
necessarily a runtime concern.) An **unset `$env` variable is not a load failure**: the wrapper is
well-formed, and the environment is not the file's to validate. It fails the run at start, before the
first step (§8.3). Operator config, which can carry wrappers too, has no load to fail at.

## 11. Deferred and owned elsewhere

- **#11 (engine execution semantics)**: branch-arm matching order and mandatory-`else`; the collect-join
  merged-output shape; while-do condition timing; when `publish` writes land; control-node output
  objects; processor lifecycle.
- **Templates / step reuse**: nothing in v0. Nested workflow files (structural reuse) and config
  inheritance (value reuse) are the v0 reuse story. `extends`/template mechanics would be additive
  post-MVP. Strict unknown-field rejection plus the `@`-version rule keeps the door open safely.
- **Deferred by earlier decisions**: API/MCP/skill step types; `config` as a condition root; input
  declarations (§2). (Both the `wait-one` and `do-not-wait` joins have since **shipped**:
  [wait-one-join.md](../spec/wait-one-join.md), [do-not-wait-join.md](../spec/do-not-wait-join.md).)
- **Escape hatch for a literal sole `$`-prefixed config key** (§8.3): parked until something concrete is
  blocked by the reservation. Further sourcing wrappers (`$file`, `$keychain`) are additive for the same
  reason: the reservation is what keeps them unambiguous.

## 12. Authoring & navigation

Hierarchical workflows are authored as plain JSON files, hand-edited, composed by relative-path `ref`s,
and navigated as a file tree. There is no dedicated authoring surface in the MVP (a design UI is out of
the map's scope). Strict ids and load-time whole-tree validation are what keep hand-authoring honest.
