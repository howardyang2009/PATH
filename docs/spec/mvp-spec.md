# PATH MVP Specification

This spec resolves wayfinder ticket [#12](https://github.com/howardyang2009/PATH/issues/12). It is the
destination artifact of [map #1](https://github.com/howardyang2009/PATH/issues/1). It assembles every
closed decision of the map into one buildable spec for the PATH MVP: a **local workflow engine (macOS
first) plus the workflow file format, able to run an LLM/agent pipeline end-to-end**.

**How to read this document.** The vocabulary follows [CONTEXT.md](../../CONTEXT.md) exactly; the terms
there are canonical. Two decisions already have normative documents in this repo, and this spec
*incorporates them by reference* rather than restate them: the
[workflow file format v0](../format/workflow-format-v0.md) and the
[acceptance workflow](../acceptance-workflow/NOTES.md). Everything else (architecture, execution
semantics, worker model, persistence, logging/audit) previously lived only in tracker resolutions. This
spec states it normatively **here**. Where this document and a tracker comment disagree, this document
wins. §12 maps every section back to its originating decision.

---

## 1. Scope

**In the MVP:**

- A headless workflow engine plus CLI (`@path/engine`) and a format schema package (`@path/schema`),
  TypeScript on Node LTS, running on macOS.
- Workflow file format v0 (JSON): three step types (`prompt`, `binary`, `workflow`); three control
  blocks (`parallel` with a `collect` or `wait-one` join, `branch`, `while-do`); `checkpoint`
  assertions; one structured condition language; `${}` interpolation; config inheritance; and worker
  declarations.
- One LLM worker: the Claude Agent SDK (pinned), with subscription-keychain and API-key auth.
- Local persistence under `.path/` (SQLite plus blob files), typed log events to db and NDJSON
  backends, and secret masking at the persistence boundary.
- Acceptance: the [release-notes pipeline](../acceptance-workflow/NOTES.md) runs end-to-end (§11).

**Out of scope** (the map ruled these out; they return only through a redrawn destination):

- Online design UI; the PATH website/cloud (remote db, storage, and log tables).
- Remote engine workers; human/person workers.
- Scheduling, todo-list features, and run-path optimization.
- Transactions, chatbot workflow generation, and single-file compilation (v2 items).
- Platforms other than macOS (the code is portable Node, but only macOS is exercised).
- Automatic in-run retry (backoff, `drain-then-fail`, `tolerate-failures`, per-branch `on-failure`).
  This is a failure policy that §5.6 rejects deliberately, independent of resume below.

**Resume of crash-interrupted runs has shipped.** Its semantics were settled first
([map #142](https://github.com/howardyang2009/PATH/issues/142),
[resume-door-verdict.md](../research/resume-door-verdict.md)). The CLI/engine surface was then built by
[map #158](https://github.com/howardyang2009/PATH/issues/158). It lands as
`path run --resume <root-run-id>` (§3): one cause-blind operator verb that re-runs a stopped tree as a
successor run, reuses every recorded `succeeded` output, and re-runs the rest. It is **at-least-once**
for every node it re-runs. §3 and §5.6 state what that owes the workflow author.

**Deferred with the door held open** — the register of deliberate extension points is §10.

Workflow/step template mechanics (`extends`) belong to that register, not to the list above. They are
**not in v0**. Nested workflow files (structural reuse) and config inheritance (value reuse) are the v0
reuse story, and nothing has yet wanted more. But `extends` adds a field to a format that rejects
unknown fields and carries an `@`-version. Thus it arrives as an addition rather than a redrawn
destination. That is what the two lists disagreed about until now.

## 2. Domain model

[CONTEXT.md](../../CONTEXT.md) is the canonical glossary (step, worker, task, run, processor,
workflow-as-step, logicer, checkpoint, config vs context, log event, trace, log backend, secret). These
are the invariants that implementers must not break:

1. Only **steps** execute on workers. Logicers and checkpoints are engine constructs: no worker, no
   task, no run.
2. Every execution is a **run of a task**. There is no separate "workflow execution" concept. An
   implicit root step wraps the top-level workflow. A workflow-step's run spawns child runs, which form
   the run tree.
3. One step has exactly **one input object and one output object**.
4. **Config flows in from outside; context is written from inside.** Context is isolated per
   workflow-run. A nested workflow starts with a fresh context and exchanges data with its parent only
   through input and output objects.
5. Worker and config are **inherited downward** from the enclosing workflow, unless a step overrides
   them (worker atomically, config key-by-key). Worker never crosses a file boundary; config does.

## 3. Architecture & stack

- **Language/runtime:** TypeScript (strict) on **Node LTS 22+**. It was chosen for the first-class
  Agent SDK and to share one schema package with the future TS/React design website. Bun and Deno were
  rejected (ecosystem risk for an engine that spawns processes).
- **Repo layout:** pnpm workspace monorepo in this repo:
  - **`@path/schema`** — the format: TypeScript types plus zod validation, **no runtime deps**. It is
    the single source of truth for format v0 (§4) and the condition language. The future website
    imports this same package.
  - **`@path/engine`** — the headless engine plus CLI. It depends on `@path/schema`.
- **Tooling:** vitest for tests, tsx for dev execution.
- **Distribution (MVP):** dev-mode CLI only. Run it through pnpm/tsx, or built JS plus node. There is no
  npm publish, no single-binary packaging, and no signing or notarization.
- **Multi-platform stance:** door-open only. Windows, Linux, and cloud come free with Node. A future
  mobile/Flutter client talks to an engine over IPC/HTTP. The MVP never bets on sharing engine code
  with mobile, and it ships no IPC/HTTP surface.

### CLI surface (minimum decided commands)

- `path run <workflow.json>` — validate the whole file tree, then execute a root run. The operator
  supplies launch-time config values through CLI flags and/or a config file. They override the top-level
  file's config defaults per format §8 (shallow merge, nearest wins).
- `path run <workflow.json> --resume <root-run-id>` — re-run a stopped tree as a **successor** run
  (§5.6). Reuse every node whose recorded run is `succeeded`. Re-run every node that is not. A resumed
  run restores its context from the original tree, so it takes no context seed. Thus the engine rejects
  a `--resume` combined with `--context` or `--set-context`. **At-least-once, and the author's burden:**
  every re-run node runs a second time. Consider a `binary` command, or a `prompt` step's worker-side
  tool call, that already produced an external effect (a `git push`, an API `POST`, a sent message)
  before the run stopped. Resume can fire it again. PATH observes only stdout, stderr, and exit-code (or
  the LLM's structured result), never world-state. Thus it cannot detect or prevent a duplicated effect,
  and it does not gate resume on step type. Idempotency, or the avoidance of externally-visible effects,
  is the workflow author's obligation, not an engine guarantee
  ([resume-side-effect-contract.md](../research/resume-side-effect-contract.md)).
- `path run <workflow.json> -C <dir>` — direct the run at the `.path/` store under `<dir>` instead of
  the default (the workflow file's own directory). Thus many workflows can pool their runs in one
  central place. **Store-only:** `-C` relocates where runs are read and written, and nothing else. The
  `workflow.json` path, nested `workflow` refs, and binary `cwd`s all still resolve as they do without
  `-C`. They are never re-rooted under `<dir>` (contrast `git -C`;
  [ADR 0005](../adr/0005-path-run-dash-c-is-store-only.md)). The flag mirrors the `-C` that `path runs`
  already takes, and it may appear anywhere in the args. Each root run records the source-workflow
  identity of the `workflow.json` that produced it (ADR 0006, §5.7). Thus a pooled store segments by
  workflow rather than a list of runs by id alone (#202).
- `path runs [-C <dir>] [--limit <n>] [--status <status>] [--workflow <name>] [--workflow-id <guid>]`
  — list root runs, most recent first. It shows each run's source-workflow name, status, and which root
  run (if any) it resumed from. `--workflow <name>` filters by the workflow's human `name`.
  `--workflow-id <guid>` filters by its durable GUID; the GUID disambiguates two files that share a
  `name` (ADR 0006). `-C <dir>` reads the store under `<dir>` (default: the working directory). It is
  the read side of the same store that the `run` `-C` writes.
- `path runs rm <run-id>` / `path runs prune` — delete run db rows and the run directory **together**
  (§6). `prune` is project-wide, so it confirms before it deletes. It lists the root runs it would
  remove and requires an interactive `yes`, or `--yes`/`-y` to skip the prompt for scripts (#166).

Operator config carries the same `$secret`/`$env` wrappers that a file's config does. What that means
on the command line is §8.3's, not this section's.

`^C` during `path run` **cancels the run** (§5.6) instead of killing the process. The run unwinds to
`cancelled`, and the CLI exits **130** (128 + SIGINT), distinct from the failed run's non-zero exit.
Cancellation holds no deadline, so a second `^C` exits immediately without a wait for the unwind. It
abandons the unwind mid-write, with the consequences §5.6 records. Cancellation is a signal, not a
flag.

Exact flag spellings are the implementer's choice. The semantics above are not.

## 4. Workflow file format v2

Normative document: [docs/format/workflow-format-v2.md](../format/workflow-format-v2.md)
(`path/workflow@2`). The older [workflow-format-v0.md](../format/workflow-format-v0.md) describes the
superseded `@1` and carries a banner that points here. This summary is for orientation only; the format
doc wins on any detail:

- A single JSON file, `"format": "path/workflow@2"`, with strict zod validation (unknown fields
  rejected). It carries a durable GUID `id` plus a file-unique human `name` on the workflow and on
  **every node** (ADR 0006/0007/0014), and one flat `type`-discriminated node union.
- **Every container slot holds exactly one node** (ADR 0014). A `parallel` branch, a `branch` arm's
  occupant, an `else`, and a `while-do` body are each a node, not a wrapper. Only two slots carry a node
  array: the file's top-level `body` and a `sequence`'s `body`.
- Nodes: steps `prompt` / `binary` / `workflow` (relative-path `ref`); logicers `parallel`
  (`join: "collect" | "wait-one" | "do-not-wait"`) / `branch` / `while-do` (mandatory `max_iterations`)
  / `sequence` (a node array wherever a slot needs several nodes in order); plus `checkpoint`.
- `${dot.path}` interpolation with the whole-string typing rule, in allowlisted positions only. Roots
  are `config` and `context`, plus `output` in `publish` maps.
- Uniform data flow: `input` builds the step's input object (absent means the previous node's output).
  `publish` writes step output to context. Workflow input seeds child context. The top-level `output`
  map is the workflow's output contract. `parse: "json"` is opt-in.
- Workers are tagged `engine` or `llm` (§7 of the format doc). Config is literal values,
  shallow-merge nearest-wins across file boundaries. `$secret`/`$env` sole-key wrappers are the one
  bounded exception to literalness, and the `$`-sole-key namespace is reserved.
- Conditions: zod-validated predicate trees (`exists`, `equals`, `one-of`, `matches`, `range`,
  `valid-json`; `all`/`any`/`not`). Roots are `context` and `output`. Error semantics are strict.
- Load-time whole-tree validation: schema, ids, `ref` cycles, `${}` syntax. Authoring errors surface at
  load, never mid-run.

## 5. Engine execution semantics

### 5.1 Scheduling baseline

A workflow body executes **strictly sequentially**. The engine walks nodes one at a time, in order.
Concurrency exists only inside `parallel` blocks. There is no lookahead and no reordering.

### 5.2 Control-node behavior

- **Branch** — the engine evaluates arms in declaration order. The **first true `when` wins**. `else`
  is optional. No match and no `else` **fails the run** (silent fall-through hides authoring bugs).
- **While-do** — the engine checks the condition **before every iteration** against current context.
  Zero iterations is a normal exit. If the condition is still true after `max_iterations` completed
  iterations, the **run fails**. Post-loop nodes may assume the condition resolved to false.
- **Checkpoint** — if the condition is true, continue. If it is false, the run stops as failed.
- **Sequence** — a logicer that holds a **node array** (`body`). It is the answer to "this single-node
  slot needs several nodes in order." Its nodes run sequentially, like a top-level body. Its output
  object is its **last child's**. Its first child's default input is the `sequence`'s predecessor's
  output (§5.4). It adds no new execution rule; it restates the block-slot rules over one node. Being a
  logicer, it has no worker, task, or run. It is a legal occupant of any single-node slot (a `while-do`
  body, a `branch` arm, an `else`, a `parallel` branch).
- **Parallel** — structured concurrency. The run tree stays **strictly nested** (every workflow-run
  contains its descendants). The `join` decides completion. `collect` waits for **all** branches.
  `wait-one` **races** them and keeps the first to succeed, and cancels the rest (a failing branch is
  ignored and the race continues; all-fail fails the block —
  [wait-one-join.md](wait-one-join.md)). `do-not-wait` **launches every branch and waits for none at
  the join**: the block completes at once with output `{}`, and the successor runs while the branches
  continue. "No detached runs" holds with one **narrow** redraw for `do-not-wait`. A branch is detached
  from its *block*, not from the tree. The engine awaits it at the boundary of the **workflow-run that
  owns the block** (the enclosing-run barrier). Thus no run outlives the process, and the strict nesting
  above is preserved. See [do-not-wait-join.md](do-not-wait-join.md) §1.1 and §2.

### 5.3 Context write timing

- Sequential flow: a step's `publish` lands **atomically on step success, before the next node
  starts**.
- Parallel flow: each branch executes against a **snapshot of context taken at block entry**. Siblings
  never see each other's writes. Branch publishes buffer and land **at the join, applied in branch
  declaration order**. Publish keys are static strings. Thus the engine checks duplicate keys over a
  branch **node's publish set**: its own `publish` keys plus those of every node reachable through its
  child bodies (a `sequence`, a nested block, any depth). It does not descend into a `workflow` step's
  ref'd file (format §5.1). It rejects duplicate keys across **concurrent sibling branch nodes** at
  **load time** under `collect`; no runtime races exist. Under `wait-one`, the same-key ban is lifted:
  only the winner's publishes land, so two branches that publish one key are deterministic
  ([wait-one-join.md](wait-one-join.md) §4.1). Under `do-not-wait`, a branch node's publish set must be
  **empty**: it lands after its would-be readers, so a write would be a nondeterministic
  write-after-read. Any `publish` reachable within a `do-not-wait` branch, including through a
  `sequence` or nested block, is a **load error** ([do-not-wait-join.md](do-not-wait-join.md) §4).

### 5.4 Node output objects

- **Step**: its own output (stdout / LLM result / child workflow `output` map), per the format doc.
- **Checkpoint**: transparent. It forwards its predecessor's output unchanged (its condition's `output`
  root reads that same object).
- **Sequence**: its **last child's** output object.
- **Branch**: the taken arm's **node's** output.
- **While-do**: the **node's** output of the final executed iteration; transparent at zero iterations.
- **Parallel (collect)**: `{ "<branch-node-name>": <that branch node's output object> }`. The key is
  the branch **node's** own `name` (format §4.3). It is deterministic regardless of completion order,
  and dot-path addressable. The shape is unchanged from `@1`; only the key's source moved from the
  deleted wrapper onto the node.
- **Parallel (wait-one)**: `{ "winner": { "name": <winning branch node's name>, "output": <that node's
  output> } }`. It is a stable `winner` key, because the author cannot know which branch wins
  ([wait-one-join.md](wait-one-join.md) §3).
- **Parallel (do-not-wait)**: the **empty object** `{}`. Every branch is detached, the block waits on
  none, and none may publish (§5.3). So there is nothing to hand downstream. A downstream `input ←` ref
  into the block's output resolves against `{}` and finds nothing. This is correct: a fire-and-forget
  block produces no readable result ([do-not-wait-join.md](do-not-wait-join.md) §3).

**Default-input chain** — the mirror rule to the outputs above. When a step omits `input` (format §6.1),
the chain threads *through* blocks. The first node of any block slot (a branch arm, a parallel branch, a
while-do body) defaults to the **block's predecessor's output object**. (Parallel siblings all start
from that same object, consistent with the context-snapshot rule.) A `sequence` needs no special
clause: its first child defaults to the `sequence`'s predecessor's output, and its later children chain
internally. This is identical to the arm, branch, and loop-body rule. A while-do body additionally
chains **across iterations**: iteration 1's node reads the block's predecessor's output; iteration N's
node reads iteration N−1's node's output. Thus blocks are transparent to one uniform chain, on both
their input and output sides.

### 5.5 Processors & the fan-out cap

- Every `prompt` step-run spawns a **fresh SDK session (processor)**, torn down when the step
  completes. There is no session reuse in MVP: a step reads exactly what its `input` map builds, with no
  hidden conversational state. Reuse and pooling are a later opt-in optimization.
- A `binary` step-run is one child process (spawned with the step's `cwd`; stdin/stdout convention per
  format §4.2; a non-zero exit fails the step). stderr is not data. The engine captures it to
  `stderr.txt` in the step-run's directory (§6), secret-scrubbed like every persisted artifact (§8.3),
  and never passes it downstream.
- One **engine-wide semaphore** caps concurrent Processors: **default 4**, overridable in engine
  config (§7 memory budget). Use the `--processor-concurrency` flag or the `processor.concurrency` key of the
  engine-settings file (§6, §9), **not** workflow Config. (The cap is one engine-wide value, so
  Config's per-file inherited override would be wrong.) It spans the entire run tree, including nested
  workflows and nested parallels. A branch whose next step cannot get a slot waits. Binary steps are
  uncapped.

### 5.6 Failure and cancellation

**Fail-fast.** A step failure, a false checkpoint, a condition evaluation error, a branch no-match, or
loop-cap exhaustion fails the run. So does a **run-start config failure**: an `$env` wrapper that names
a variable that is not set (format doc §8.3). This lands before the first step rather than at load. The
engine starts and records the run, then ends it `failed`, and names every unset variable at once.
Operator config is a run input rather than a file, so half of what is checked has no load to fail at. A
client that watches a run needs a run to watch. A failing `collect` parallel branch **cancels in-flight
siblings best-effort** (processor killed, cause `sibling-failed`). A `wait-one` winner cancels its
still-running losers the same way (cause `sibling-succeeded`; a losing *failure* cancels nothing —
[wait-one-join.md](wait-one-join.md) §5). A `do-not-wait` branch is the third case, and it
**cross-cancels nothing**. A failed detached branch cancels neither its siblings nor the main path
(which has already moved on). Its failure **does not fail its tree**: the branch's `failed` is recorded
on its own run row and there it stops. Thus a workflow-run may end `succeeded` with a `failed` detached
branch in its subtree. This deliberately breaks the fail-fast invariant that a failed descendant fails
its ancestor. It is confined to `do-not-wait` and captured as
[ADR 0008](../adr/0008-do-not-wait-detached-failure-does-not-fail-tree.md). Isolation means the failure
does not *propagate*, not that it is hidden; it stays fully auditable
([do-not-wait-join.md](do-not-wait-join.md) §5). The cancel **cause union is unchanged**
(`operator` | `sibling-failed` | `sibling-succeeded`), because `do-not-wait` adds no sibling-driven
cancel path (the barrier *waits* rather than cancels), so it introduces no new cause
([do-not-wait-join.md](do-not-wait-join.md) §6). `cancelled` is a distinct run status from `failed`. No
publishes from cancelled or failed branches land. Rejected for MVP: drain-then-fail, tolerate-failures
(allSettled), and a per-branch on-failure policy (the latter two would be additive format changes).
Automatic in-run retry stays out of scope (§1). Resume, an operator-initiated re-run of a stopped tree,
cause-blind, reuses every recorded `succeeded` output. It has shipped as `path run --resume` (§3). See
[resume-door-verdict.md](../research/resume-door-verdict.md) and §1. Because it is **cause-blind**,
every not-`succeeded` node re-runs regardless of *why* it stopped. So resume is **at-least-once**: a
re-run node that already had an external side effect can fire it again, and the engine, blind to
world-state, neither detects nor prevents the duplicate. Idempotency is the workflow author's burden,
not an engine guarantee. It holds identically for `binary` and `prompt` steps
([resume-side-effect-contract.md](../research/resume-side-effect-contract.md)).

**External abort.** An operator may **cancel a root run in flight** (`RunOptions.signal`). The abort
reaches every descendant run and leaf step of the tree, and the root run ends **`cancelled`**. It does
not die mid-step, and it is not left as a lying `running` row. The unit of cancellation is the **root
run only**: one verb, one controller. To cancel a nested run or a single step is out of scope, because
it would need an answer to "does the parent continue?" that collides with fail-fast. There is no
intermediate `cancelling` status; the unwind window is client-local UI state. A signal already aborted
when the run is launched cancels it before its first step. Cancellation is **best-effort** in both
causes: the engine asks, and holds no kill deadline and no force path. `run-cancelled` names which cause
killed a run (`operator` | `sibling-failed` | `sibling-succeeded`, §8.1). What a stop owes is the truth
about where the run got to, not the ability to resume it. That truthfulness is now the precondition that
resume's reuse mechanism depends on
([resume-door-verdict.md §4.2](../research/resume-door-verdict.md)): a resumed run trusts a run's
recorded status without a re-verify.

**The forced exit is the one exception, and it is accepted.** The engine has no force path. But the
CLI's second `^C` (§3) forces the *process*, which abandons the unwind wherever it had got to. The run's
rows keep whatever status they last held, typically `running` for the root and its in-flight leaves. The
engine never writes the terminal `step-finished`, and the backends never close. This is precisely the
lying `running` row that this section says cancellation avoids. That is the price of the escape hatch,
and it is deliberate. An operator who forces an exit has decided that a return of their terminal
outranks a truthful record, and to make the force path wait for writes would defeat it. Nothing
reconciles such rows afterwards. There is no startup reconcile pass, and resume does not own the
building of one ([resume-door-verdict.md §5](../research/resume-door-verdict.md)). So a forced run stays
`running` in `path runs`, in `GET /v0/runs`, and in any viewer over it, until the operator removes it
with `path runs rm <run-id>` (§3). Cancelling without forcing has none of these consequences. This
applies to the second `^C` alone.

### 5.7 Run records

Run rows exist for **step runs only** (domain invariant 1 — control nodes have no runs). Row content:
run id, parent run id, node id (the durable GUID), node name (the human label, ADR 0007), worker
binding, status (`pending | running | succeeded | failed | cancelled`), timestamps, and input/output
object refs (§6). For LLM runs it also holds `usage` (real token counts) and `estimated_cost_usd` (§7).
A **root row** also carries the producing workflow's **source-workflow identity**: its durable GUID
`workflow_id`, human `workflow_name`, and store-relative `workflow_path` (ADR 0006, #202). Thus a
central `-C` store (ADR 0005) groups a run by the workflow that produced it rather than a list of
anonymous run-ids. These three are **root-only**: null on every nested row, whose producing node is
already named by its own `node_id` and `node_name`. Usage and cost are recorded **leaf-only**: on the
prompt-step runs where tokens were actually spent. No row stores derived totals. Subtree and whole-run
figures are a read-time SUM over descendants (the CLI may display them). Thus ground truth exists
exactly once, and nothing can drift. The SUM is **status-blind**. A `do-not-wait` detached branch is an
ordinary tree member for cost, so its spend counts toward the root figure **regardless of the branch's
status**. A `failed` detached branch still burned the tokens it burned, and the roll-up records real
spend, not successful spend. The enclosing-run barrier (§5.2) guarantees every detached branch is
terminal before its owning run exits, so all detached spend is **final at roll-up time**
([do-not-wait-join.md](do-not-wait-join.md) §8). Control-node activity is recorded as typed log events
(§8), attributed to the enclosing workflow-step's run.

**Amendment for a successor run** (resume, §1, §5.6): a reused node's usage and `estimated_cost_usd`
row lives only in the *original* tree. A successor run's own descendants do not include it. The SUM
traverses the reuse-marker link into the original tree for every reused node rather than a duplicate of
rows into the new tree. To duplicate would create two ground truths for the same spend, the exact
failure that this section's "exactly once" rule exists to prevent
([resume-door-verdict.md §4.3](../research/resume-door-verdict.md)).

## 6. Persistence

**Hybrid: SQLite for structured records, plain files for blobs, all under a per-project `.path/`
directory** beside the workflow files (like `.git`), gitignored by default.

- **`.path/path.db`** — SQLite through **better-sqlite3** (the synchronous API fits the single-process
  engine). It holds structured records only: the **runs table** (§5.7) and the **log table** (§8).
- **`.path/settings.json`** — the **engine-settings file** (§9): a flat JSON object that carries the two
  engine-level operator settings, `log.backends` (§8.2) and `processor.concurrency` (§5.5). The engine reads
  it; a step never does. It is not workflow Config and never merges into `${config.x}`. An absent file
  means built-in defaults. Unknown keys and bad values are rejected loudly, like the workflow format. An
  empty `log.backends` list selects no backends, the file spelling of `--log-backends none`. Nearest
  wins: **CLI flag, then engine-settings file, then built-in default.**
- **`.path/runs/<root-run-id>/`** — one directory tree per **root** run, mirroring the run tree. Inside
  it is one subdirectory per run in the tree (keyed by run id), which holds that run's blobs:
  `input.json`, `output.json`, `context.json` (a workflow-run's own blackboard; a leaf step's is a
  per-step snapshot, see below), and for binary runs `stderr.txt`. `run.log` (§8) sits at the tree
  root. Every blob is a **JSON file** referenced by relative path from its run row. There is no
  size-threshold inlining: one rule, every object cat-able on disk.
- **Context write-through:** every workflow-run has its own isolated context, hence its own
  `context.json` in its run subdirectory. Each context mutation atomically rewrites it, so on-disk state
  always matches the live blackboard. Thus mid-run inspection works, crashes leave a truthful snapshot,
  and the door stays open for future resume semantics. In addition, every succeeded leaf step writes a
  `context.json` of its own: a snapshot of the enclosing workflow-run's context taken right after that
  step's publish landed. Thus the context is followable step by step alongside each step's input and
  output.
- **Retention: keep everything.** There is no automatic expiry. `path runs rm <root-run-id>` and
  `prune` operate on root runs. They delete the run tree's db rows and its directory tree together, so
  the two stores never drift and nothing can half-delete.
- **Schema evolution:** stamp the db schema version with `PRAGMA user_version`. On mismatch, the engine
  **refuses to open**, with a clear message to delete and recreate `path.db` (blob files unaffected).
  There is no migration framework pre-1.0. This mirrors the format's exact-version rule: pre-1.0,
  nothing migrates, and everything fails loudly.

## 7. The LLM worker

- **Implementation: Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), **pinned**. The spike ran
  **0.3.214** (bundled Claude Code binary 2.1.214). One SDK session equals one processor, which maps 1:1
  onto the domain model. MCP servers and skills are **worker-side invocation options** (the `options`
  bag of the `llm` worker declaration, format §7), not engine concerns. No engine code speaks MCP in
  MVP.
- **Auth:** the SDK picks up the macOS-keychain subscription OAuth credential when no
  `ANTHROPIC_API_KEY` is set, and the API key when it is. **No headless-CLI fallback mode is built.**
  Caveats (accepted while PATH is a personal local tool): keychain pickup is undocumented SDK behavior,
  and Anthropic policy forbids the *offering* of claude.ai login in a distributed product. The worker
  contract stays **message-shaped**, so a headless-CLI worker or remote runner is a drop-in alternate if
  either caveat bites.
- **Memory budget:** about 360 MB RSS per live processor, flat under fan-out. Thus the budget is **about
  400 MB per concurrent LLM processor**. Hence the default semaphore cap of 4 (about 1.5 GB, comfortable
  on 16 GB machines), config-overridable (§5.5).
- **Cost accounting:** the SDK's `total_cost_usd` is a client-side estimate at API list prices. It is
  real for API-key users and notional under subscription. Store it as **`estimated_cost_usd`** on the
  run row, alongside `usage` token counts, which are always real.
- **Later, additive:** a lightweight `llm-call` worker type over the direct API (no agentic loop); and
  local runtimes as offline fallback. Survey:
  [llm-worker-execution-options.md](../research/llm-worker-execution-options.md). Empirics:
  [agent-sdk-spike-findings.md](../research/agent-sdk-spike-findings.md).

## 8. Logging & audit

### 8.1 Event stream

The log stream is the **full narrative**. The engine emits step lifecycle events in addition to run
rows, so the log alone reads as the complete chronological story of a run tree. Run rows remain the
authoritative queryable step record. Events are lightweight observations.

**Envelope** (every event): `seq` (monotonic per **root run**, engine-assigned — the ordering truth;
timestamps collide under parallelism), `ts`, `type` (flat discriminated union, one zod schema),
`run_id`, `node_id` (the durable GUID), and `node_name` (the human label, ADR 0007 — both null for the
implicit root step). Control events carry the enclosing workflow-step's run id plus the control node's
id and name. Lifecycle events carry the step's own run id. There are no workflow start and end events:
workflow-as-step means they are just the workflow step's `step-started` and `step-finished`.

**Event set** (payload beyond the envelope):

| Event | Payload |
|---|---|
| `step-started` | `step_type`, `worker` |
| `step-finished` | `status` (`succeeded`/`failed`/`cancelled`), `error` message on failure (binary steps: exit code + short stderr tail; full stderr is a blob, §6) |
| `branch-taken` | `arm` (index or `"else"`), winning arm's `trace` |
| `branch-no-match` | all arms' `trace`s |
| `checkpoint-passed` / `checkpoint-failed` | `trace` |
| `iteration-started` | `iteration` (1-based), `trace` |
| `loop-exited` | `reason` (`condition-false` / `max-iterations-exceeded`), `iterations`, final `trace` |
| `join-applied` | `branches` (names in apply order), `published_keys`, `winner` (winning branch name, `wait-one` only) |
| `run-cancelled` | `cause` (`sibling-failed` / `sibling-succeeded` / `operator`, §5.6), `cause_run_id` (the failing sibling; null for a `sibling-succeeded` or operator cancel) |

**Trace** is the condition tree, annotated per leaf with its dot-path, its outcome
(`true | false | error` plus a message; strict-semantics evaluation errors surface as `error` leaves,
not a separate event type), and the **actual value read**, post-masking.

**Versioning is per stream, not per event.** The NDJSON file opens with a header line
`{"type": "log-header", "format": "path/log@0", "run_id": ...}`. The db side is covered by
`PRAGMA user_version`.

### 8.2 Backend seam

```ts
interface LogBackend {
  open(run: { runId: string; format: "path/log@0" }): Promise<void>;
  write(event: LogEvent): Promise<void>;
  close(): Promise<void>; // flush; called on run end, success or failure
}
```

- The engine instantiates it **per root run**. All events of the run tree flow through it. NDJSON is one
  `run.log` per root run (nested runs interleave, matching per-root `seq`). The db backend stamps rows
  with the root run id from `open()`.
- **Async signatures, engine-serialized.** There is one internal write queue per backend, never
  concurrent `write` calls. Local backends resolve synchronously. The async seam exists for future
  remote backends.
- **Backends are dumb sinks.** Envelope assembly, `seq`, and masking happen engine-side before the
  seam. Thus a backend cannot leak what the engine already redacted.
- **Configuration.** The backend list is engine-level operator settings (`log.backends:
  ["db", "ndjson"]`), *not* workflow-file content. Use the `--log-backends` flag or the `log.backends`
  key of the engine-settings file (§6, §9). **Both are on by default.**
- **Failure policy.** Any active backend write failure **fails the run** (audit-first: to execute steps
  whose events cannot be recorded defeats the tool's purpose). The engine still best-effort emits
  terminal events to surviving backends.

### 8.3 Secret masking

- **Marking:** a config value may be wrapped as `{"$secret": "<value>"}`. The wrapper is the marking.
  Because config composes by shallow merge per top-level key, secrecy travels with the value across
  every file boundary and operator override.
- **Sourcing:** `{"$env": "NAME"}` sources a value from the environment and composes with the marking by
  nesting: `{"$secret": {"$env": "NAME"}}`. Normative: **format doc §8.3**, which owns the wrapper
  shape, the one-way nesting, where a wrapper may sit, what an unset or empty variable does, and the
  reserved `$`-sole-key namespace. What follows is this section's, because it is the masker's:
- **Resolution runs at run start, *before* secret collection.** This is forced, not stylistic. The
  masker collects **values**. So a `{"$secret": {"$env": "TOKEN"}}` collected before resolution would
  have it scrub the literal string `TOKEN` while the credential reached disk unmasked. Workers get the
  resolved value; the masker redacts that same value. One environment snapshot per run, taken here, is
  what stops two steps from a disagreement about one wrapper. A variable that is not set fails the run
  before its first step, and names every missing variable at once (format doc §8.3). Thus a secret that
  never arrived is a failed run, never a `[secret:key]`-shaped hole in the artifacts.
- **An env-sourced secret is a secret like any other**, including the sharp edges. It joins the
  collected set. An empty one (`FOO=`, which counts as set) trips the short-secret warning below.
  Masking skips a zero-length value rather than a replacement between every character.
- **Operator config carries wrappers too, and that is the point on the command line.** `--set` and
  `--config` values reach the same resolution: `--set 'token={"$secret":{"$env":"NAME"}}'` is a real
  wrapper, because a `--set` value is read as JSON when it parses as JSON, and as a bare string
  otherwise. To let the *shell* expand it instead (`--set token=$TOKEN`) puts the secret in argv,
  readable by every process on the machine, and in shell history. To name the variable keeps only the
  name there. One asymmetry, stated because it surprises: the CLI does **not** schema-check operator
  config. So format doc §8.3's reserved-`$key` load error does not fire for it. A misspelled
  `--set 'token={"$evn":"NAME"}'` is an ordinary object that fails later, or reaches a worker. Files are
  validated at load, and the server validates posted config ([server API spec](server-api-spec.md) §2).
  `--set` and `--config` are the gap.
- **Redaction: persistence-boundary scrubbing by value.** At run start the engine collects all
  `$secret` values in effective config. Everything persisted (log events and traces, input/output
  object files, `context.json` write-throughs, the `error` a failed `step-finished` event carries, and
  captured stderr) is string-scrubbed before it hits any backend or disk. That event is the only *record
  of a run's error*: §5.7's row content has no error among it (#124). It is not the only place the text
  can appear. A binary step's error is the tail of its stderr, which is also persisted as `stderr.txt`
  (§6). This is why masking is by value across every artifact rather than per-field. It is required, not
  hygiene: `${config.token}` legally splices into prompts, argv, and inputs, so secrets propagate into
  artifacts, and path-based redaction leaks.
- **Replacement token:** `[secret:<config-key>]` (the same value under two keys means the first key
  wins).
- **Workers receive real values.** Masking is an audit-surface concern, not a dataflow restriction.
- **What a finished run hands its caller is masked too, everything but the product (#123).** A run's
  `error` carries text the engine did not compose from workflow authorship (a failed step's error is the
  tail of its stderr, where a client prints a rejected credential). Every caller prints it: the CLI on
  its own stderr, the server on its console. Under `$env`, that terminal is routinely a CI build log:
  retained, searchable, and read by people who never held the credential. That is the exposure that
  `$secret` exists to close. So `error` is always masked. So is the returned `output` of a run that did
  **not** succeed: a failed or cancelled run has no output contract, and what comes back is the run's
  input kept for debugging. A **succeeded** run's output is the exception and the point of the rule: it
  is the product, the CLI prints it, and an operator is owed their pipeline's answer rather than
  `[secret:key]`. The run-start unset-variable failure rides the same `error` field and names variables,
  not values. There is nothing in it to scrub.
- **Documented limits.** Transformed secrets (base64, embedded in emitted JSON) escape string matching.
  This is accepted; there is no taint-tracking in MVP. `$secret` values shorter than about 6 chars risk
  mass false-replacement, so the engine emits a warning at run start with the rest of the collection (an
  env-sourced secret has no value to measure at load). A thrown **bug** also escapes: the engine
  re-throws it rather than swallow one into a failed run. So its message and stack reach the caller, and
  the CLI's or the server's console, unscrubbed. To close it would mean a catch at the run boundary,
  which changes what a bug is. A failed *run* is the masked path.

## 9. Implementation freedoms

Decided-by-omission. Implementers may choose freely, provided the semantics above hold:

- Exact CLI flag spellings and the operator config-file format (§3).
- SQLite DDL (table and column names, indexes) behind the run-row and log-event contracts.
- Run-id format; internal engine module structure; error-message wording.
- The engine-settings file location and format (it must carry `log.backends` and the Processor cap). Settled
  in #27 as `.path/settings.json`, a flat strict-unknown-field JSON object keyed `"log.backends"` and
  `"processor.concurrency"` (§6). Being inside the gitignored `.path/`, it is a per-checkout operator setting,
  not a committed project artifact.

## 10. Deferred register (doors deliberately held open)

| Deferred | Where the door is |
|---|---|
| ~~`wait-one` / `do-not-wait` joins~~ | **Both shipped** — the `join` field now carries all three values. `wait-one` ([wait-one-join.md](wait-one-join.md)) and `do-not-wait` ([do-not-wait-join.md](do-not-wait-join.md), §5.2/§5.4/§5.6/§5.7 above) each graduated from a held-open door to built behavior (register #109) |
| API-endpoint step type | curl through `binary` today; a real HTTP workflow (#129) did **not** promote it — `--config -` answers argv and needs no shell; the open cost is status-and-body. Trigger in #109 |
| MCP/skill step types | live as LLM-worker `options`; revisit only for engine-direct calls |
| Function-in-binary step | v-next shape: in-process JS-module call, not FFI |
| `config` as a condition root | additive third root |
| Input declarations on workflows | additive top-level field |
| Templates / `extends` | nested files (structural reuse) + config inheritance (value reuse) are the v0 story; strict unknown-field rejection + `@`-versioning keep an addition to them safe (§1) |
| Session reuse / processor pooling | fresh-processor rule is the contract; pooling is opt-in later |
| `llm-call` worker type; local-runtime workers | message-shaped worker contract |
| Automatic in-run retry | Stays deferred — backoff, `drain-then-fail`, `tolerate-failures`, per-branch `on-failure` (§1, §5.6). Distinct from resume, which **shipped**: map [#142](https://github.com/howardyang2009/PATH/issues/142) settled the semantics, [#158](https://github.com/howardyang2009/PATH/issues/158) built the surface, and `path run --resume` (§3) is the one cause-blind operator verb it landed as |
| Remote log backends | async `LogBackend` seam |
| A failed run's error on the run row | additive to §5.7's row content; today the error is the log stream's alone (§8.3), so a run row must be joined to it to say *why* (#124, and map #113's parked server/SSE/viewer question) |
| Website/cloud, remote engines, mobile | shared `@path/schema`; IPC/HTTP boundary |

## 11. Acceptance

The MVP is done when the [release-notes pipeline](../acceptance-workflow/NOTES.md)
(`docs/acceptance-workflow/release-notes.workflow.json` plus `revise-cycle.workflow.json`) runs
end-to-end on macOS through `path run`, with no dependencies beyond git, a shell, and the Agent SDK worker,
and it:

1. produces `RELEASE_NOTES.md` for a real commit range;
2. leaves a complete audit trail: run rows for every step run, log narrative in **both** backends (db
   table plus `run.log`), and every input/output object and `context.json` on disk under
   `.path/runs/<run-id>/`;
3. demonstrates the failure paths: an empty commit range trips the `have-changes` checkpoint, and a
   never-passing judge exhausts `max_revisions` and fails the run;
4. respects the LLM fan-out cap and records `usage` plus `estimated_cost_usd` on every LLM run.

The pipeline's coverage map (every MVP construct with its exercising node) is in the acceptance
workflow's NOTES.md.

## 12. Decision record

| Section | Decision ticket |
|---|---|
| Domain model (§2) | [#2](https://github.com/howardyang2009/PATH/issues/2), recorded in CONTEXT.md |
| Stack & layout (§3) | [#3](https://github.com/howardyang2009/PATH/issues/3) |
| Step-type subset (§1, §4) | [#4](https://github.com/howardyang2009/PATH/issues/4) |
| Logicer subset & block grammar (§4, §5) | [#5](https://github.com/howardyang2009/PATH/issues/5) |
| LLM worker survey (§7) | [#6](https://github.com/howardyang2009/PATH/issues/6), recorded in the research doc |
| Condition language (§4) | [#7](https://github.com/howardyang2009/PATH/issues/7) |
| Persistence (§6) | [#8](https://github.com/howardyang2009/PATH/issues/8) |
| Acceptance workflow (§11) | [#9](https://github.com/howardyang2009/PATH/issues/9), recorded in docs/acceptance-workflow/ |
| File format v0 (§4) | [#10](https://github.com/howardyang2009/PATH/issues/10), recorded in the format doc |
| Execution semantics (§5) | [#11](https://github.com/howardyang2009/PATH/issues/11) |
| Agent SDK spike (§7) | [#13](https://github.com/howardyang2009/PATH/issues/13), recorded in the findings doc |
| Logging & secrets (§8) | [#14](https://github.com/howardyang2009/PATH/issues/14) |
| `$env` config sourcing (§3, §8.3) | [#113](https://github.com/howardyang2009/PATH/issues/113), recorded in format doc §8.3 |
| Single-node container slots + `sequence` (§4, §5) | [#265](https://github.com/howardyang2009/PATH/issues/265), recorded in the format v2 doc, [ADR 0014](../adr/0014-single-node-container-slots-and-sequence-logicer.md) |
