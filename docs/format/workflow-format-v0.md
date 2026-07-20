# PATH Workflow File Format v0

Resolves wayfinder ticket [#10](https://github.com/howardyang2009/PATH/issues/10). This document is
the normative definition of the v0 workflow file format; `@path/schema` implements it as zod
schemas. Vocabulary follows [CONTEXT.md](../../CONTEXT.md). Runtime semantics (scheduling, when
context writes land, branch-arm matching, collect output shape, condition timing) are owned by
ticket #11 — this document fixes the *shape* of the format and the data-flow contracts it implies.

Worked example: the acceptance pipeline in
[docs/acceptance-workflow/](../acceptance-workflow/) is written in this format.

## 1. File & envelope

- A workflow file is a single **JSON** document (UTF-8). JSON is the only syntax in v0.
- Recommended file naming: `<name>.workflow.json`.
- Every file declares `"format": "path/workflow@0"` — identity and version in one required string,
  exact-match validated. An engine that does not speak the declared version **fails at load**; there
  are no format migrations pre-1.0 (mirrors the persistence decision).
- Validation is **strict**: unknown fields anywhere are rejected.

## 2. Top-level workflow object

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | yes | Exactly `"path/workflow@0"`. |
| `name` | yes | Workflow name, pattern `^[a-z][a-z0-9-]*$`. |
| `worker` | yes | Default worker for the file's steps (§7). Steps override atomically. |
| `config` | no | The file's config defaults (§8). |
| `body` | yes | Non-empty array of nodes (§4). |
| `output` | no | Interpolation map defining the workflow's output object (§6.4). Absent = `{}`. |

v0 has **no input declaration**: the input object arrives at runtime (from the parent workflow-step,
or empty for a top-level run) and seeds the initial context (§6.3). Declaring/validating expected
input keys is a possible additive extension.

## 3. Conventions

- **Discriminator**: every tagged union in the format discriminates on a single field named
  `type` — body nodes, workers, and conditions alike. There is no second-level tag: step kinds and
  control constructs form **one flat node union**.
- **Ids**: every body node (steps, blocks, checkpoints) carries a required `id`, pattern
  `^[a-z][a-z0-9-]*$`, **unique across the whole file** (all nesting levels). Parallel branch ids
  share the same pattern and the same uniqueness scope.
- The step-vs-control distinction (only steps have workers/tasks/runs) remains a domain rule
  enforced by the schema, not an extra nesting level in the JSON.

## 4. Node union

`body` elements are nodes; `type` is one of:

| `type` | Kind | Node-specific fields |
| --- | --- | --- |
| `prompt` | step | `prompt` |
| `binary` | step | `command`, `args?`, `cwd?` |
| `workflow` | step | `ref` |
| `parallel` | control | `join`, `branches` |
| `branch` | control | `arms`, `else?` |
| `while-do` | control | `condition`, `max_iterations`, `body` |
| `checkpoint` | control | `condition` |

Step-type-specific fields sit **directly on the node** (no `payload` wrapper). Future step types
must choose field names that do not collide with engine-owned fields (`type`, `id`, `worker`,
`config`, `input`, `parse`, `publish`).

### 4.1 Common step fields

All three step types additionally accept:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | §3. |
| `worker` | no | Atomic override of the inherited worker (§7). |
| `config` | no | Key-level override/extension of the inherited config (§8). |
| `input` | no | Builds the step's input object (§6.1). Absent = previous node's output object. |
| `parse` | no | `"text"` (default) or `"json"` (§6.5). |
| `publish` | no | Context writes from the step's output (§6.2). Absent = writes nothing. |

Control nodes take **none** of `worker`/`config`/`input`/`parse`/`publish` — they have no worker,
no task, no run.

### 4.2 Step types

**`prompt`** — `prompt` (string, interpolable) is the instruction text. The worker (an LLM worker)
receives the prompt plus the step's entire input object, rendered. There is no `context_refs`
mechanism: what the step reads is exactly what its `input` map builds.

**`binary`** — `command` (string), `args` (string array, default `[]`), `cwd` (string, default: the
directory of the workflow file), all interpolable. A **relative `cwd` resolves against the
directory of the workflow file**, the same anchor as its default — never against the directory
`path run` was invoked from, so a workflow behaves the same wherever it is launched. I/O
convention:

- The input object is written to the process's **stdin**: raw bytes if it is a string, otherwise
  its JSON serialization.
- The output object is the captured **stdout** (a string, unless `parse: "json"`).
- A **non-zero exit code fails the step** (and thus the run). stderr is not data; it is captured
  for audit (a per-step-run `stderr.txt`, see the MVP spec's persistence section), never passed
  downstream.

**`workflow`** — `ref` (string, *not* interpolable) is a relative path to another workflow file,
resolved against the directory of the referencing file. The child run starts with a fresh context
seeded only by its input object (§6.3); data returns only through the child's `output` object.
Config crosses the boundary (§8); **worker does not** — every file declares its own (§7).

### 4.3 Control nodes

Every slot a block owns holds a **body** (non-empty node array) — one nesting rule everywhere; a
multi-step branch never forces a nested file.

**`parallel`** — `join` is `"collect"` (the only v0 value; `wait-one` / `do-not-wait` are deferred
by the MVP logicer decision but the field stays). `branches` is a non-empty array of
`{ "id", "body" }`; the id names the branch for logs and gives the collect join a stable key
(collect's merged-output shape is #11's).

**`branch`** — `arms` is a non-empty array of `{ "when": <condition>, "body" }`, plus an optional
top-level `else` body. Arm ordering/matching semantics and whether `else` is mandatory are #11's.

**`while-do`** — `condition` (a condition, §9) sits on the block; evaluation timing is #11's
(the acceptance pipeline requires check-before-each-iteration). `max_iterations` is a positive
integer or an interpolable string resolving to one — **required**, per the MVP logicer decision;
exceeding it fails the run. `body` as above.

**`checkpoint`** — `condition` only: true → continue; false → the run stops as failed. Mechanical
assertions only (judge-step pattern for anything requiring judgment).

## 5. Interpolation

- Syntax: `${dot.path}` inside JSON strings. Escape a literal `${` as `$${`.
- **Whole-string rule**: if a string is exactly one placeholder, it resolves to the referenced
  value with its **real type** (`"max_iterations": "${config.max_revisions}"` → the number).
  Otherwise the string is a **splice**: each part stringifies; splicing a non-scalar
  (object/array) is a runtime error.
- Unresolvable paths are errors (strict, matching the condition language).
- **Evaluated positions** (allowlist — inert everywhere else, notably ids, `type` tags, `format`,
  `join`, `ref`, and condition trees, which have their own language):
  - step payload fields (`prompt`, `command`, `args`, `cwd`)
  - `input` values (§6.1)
  - `publish` values (§6.2) and workflow `output` values (§6.4)
  - `worker` declaration values
  - `max_iterations`
- **Roots**: `config` and `context`. In `publish` maps only, the additional root `output` — the
  step's own output object. Bare roots are valid (`"${output}"`, `"${context}"`). Paths are plain
  dot-paths per the condition-language rules (numeric segments index arrays; no wildcards).

## 6. Data flow

### 6.1 Step input

`input` is **any JSON value**, interpolated: a map is the common case, but a bare `"${context.x}"`
(whole-string rule) makes that value the entire input object, and literals are allowed. When
`input` is absent, the step's input object is the **previous node's output object** (for the first
body node: the workflow's own input object). Inside block slots (branch arms, parallel branches,
loop bodies) the default-input chain threads through the block — the chain rule, like the output
shapes of control nodes, is owned by the engine execution semantics (MVP spec §5.4).

### 6.2 Publishing to context

`publish` is a map of context-key ← interpolated value, with `output` available as a root alongside
`config`/`context`. Covers whole-object (`"${output}"`), rename, and deep-pick with the one
interpolation mechanism. A step without `publish` writes nothing to context. *When* the write
lands is #11's.

### 6.3 Workflow input seeds context

At run start, each top-level key of the workflow's input object becomes a context key —
conceptually the implicit root step's one write. Body nodes read it via `context.*` in
interpolation and conditions; no separate `input` root exists.

### 6.4 Workflow output

The top-level `output` map (roots `config`/`context`) is evaluated at successful run end and is the
workflow's output object — the explicit contract a parent's `publish` reads from. Absent = `{}`.

### 6.5 Output parsing

`parse: "json"` makes the engine parse a string output into a structured value before it becomes
the step's output object; for LLM output a surrounding markdown code fence is stripped first.
Unparseable → the step fails. Default `"text"` leaves the raw string. (This is why deep paths like
`context.verdict.pass` work: the judge step declares `parse: "json"`. The `valid-json` predicate
remains for strings deliberately left unparsed.)

## 7. Worker declaration

Tagged on `type`:

- `{ "type": "engine" }` — the local engine executes the step (binary steps).
- `{ "type": "llm", "model": <string>, "options": { … } }` — the Agent SDK worker (per the
  LLM-worker decision); `model` required; `options` is the named bag for SDK invocation options
  (MCP servers, skills, system prompt — exact keys pinned by the engine spec against the pinned
  SDK version).

`worker` is **required at workflow level** and inherited by the file's steps. A step-level
`worker` **replaces the inherited one wholly** (atomic — no field merge). Worker does **not**
cross the nested-file boundary: each file's contract is self-contained. Worker values are
interpolable (e.g. `"model": "${config.model}"`).

## 8. Config

Config is a JSON object of **literal values** — no interpolation inside config; it is a source,
not a consumer. Composition is a **shallow merge per top-level key, nearest wins**:

```
step config  >  enclosing workflow's effective config  >  file's own config (defaults)
```

Operator launch-time values (CLI flags/file) override the top-level file's defaults the same way.
At a workflow-step boundary the parent's effective config flows into the child file and shadows the
child's declared defaults key by key — context is isolated; config deliberately is not. Steps never
write config.

## 9. Conditions

As decided in ticket #7: zod-validated structured predicate trees, discriminated on `type`
(settling the field name #7 deferred here). Predicates `exists`, `equals`, `one-of`, `matches`,
`range`, `valid-json`; combinators `all`/`any`/`not`; dot-paths over roots `context` and `output`;
strict error semantics. Interpolation is never evaluated inside condition trees.

## 10. Load-time validation

The engine loads the **whole file tree** (following `ref`s) before any step runs, and rejects:

- unknown `format` versions; any schema violation (strict zod, unknown fields rejected)
- duplicate or pattern-violating ids/names; empty bodies
- reference cycles between workflow files; unresolvable `ref` paths
- duplicate `publish` keys across sibling branches of one `parallel` block (per the execution
  semantics: publish keys are static, so the race is detectable — and rejected — at load)
- malformed `${}` syntax in interpolable positions, and `${}` roots other than the allowed ones

Authoring errors surface at load, never mid-run. (Path *resolvability* against runtime data is
necessarily a runtime concern.)

## 11. Deferred and owned elsewhere

- **#11 (engine execution semantics)**: branch-arm matching order & mandatory-`else`; collect-join
  merged-output shape; while-do condition timing; when `publish` writes land; control-node output
  objects; processor lifecycle.
- **Templates / step reuse**: nothing in v0 — nested workflow files (structural reuse) and config
  inheritance (value reuse) are the v0 reuse story. `extends`/template mechanics would be additive
  post-MVP; strict unknown-field rejection plus the `@`-version rule keeps the door open safely.
- **Deferred by earlier decisions**: `wait-one`/`do-not-wait` joins; API/MCP/skill step types;
  `config` as a condition root; input declarations (§2).

## 12. Authoring & navigation

Hierarchical workflows are authored as plain JSON files, hand-edited, composed by relative-path
`ref`s and navigated as a file tree — no dedicated authoring surface in the MVP (a design UI is out
of the map's scope). Strict ids and load-time whole-tree validation are what keep hand-authoring
honest.
