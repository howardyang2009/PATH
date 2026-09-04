# PATH — Ubiquitous Language

This is the glossary for the PATH workflow management system. These terms are canonical. Code, specs,
and issues use them exactly.

## Core execution model

- **Step** — the unit of work in a workflow. It has exactly one input object and one output object. A
  step declares *what* to do (its type and payload). It does not declare *who* does it.
- **Worker** — *how* a step's type produces its output: a named `run` method, one of the set its step
  type ships. A Worker is no longer a venue (`engine`, `llm` are gone) — it is the method itself, so
  `Task = Step + Worker` reads literally. A step type ships one or more workers, all reaching the same
  result by a different route (a local method, a library, a remote service); "same result" is an
  author-trust contract, not an enforced check. The pair `(type, name)` is a worker's identity, so a
  name is unique only inside its type. You select a worker per step by **name** (`"worker": "sdk"`);
  when you do not, the step uses its type's **default worker**. There is no worker inheritance: a
  type-scoped name is meaningless across types, so shared data like `model` travels through config
  instead. A worker's `run` is in-process TypeScript loaded into the engine, so a worker is
  **author-trusted code** at the level of PATH's own source: it
  holds every **Secret** of the run and not only its own step's, and to add one is to edit the engine
  (ADR 0020). Two rules follow from that trust, and review is what enforces them. A worker reports
  diagnostics by *returning* `stderr`, never by writing to a process stream. And it reads the
  environment only through a resolved **Env-sourced value**, never `process.env` directly, because that
  is the door an operator's config is checked at (ADR 0012).
- **Default worker** — the worker a step of a given type uses when it names none. Each step type
  declares exactly one (`binary`'s `spawn`, `prompt`'s `sdk`). Most steps use it and write no `worker`
  field. It is a required key on the type, not a reserved worker name.
- **Task** — a step bound to a worker. `task = step + worker`.
- **Run** — one executing (or executed) instance of a task. It is the only execution term in PATH.
  There is no separate "workflow execution" concept.
- **Processor** — one live instance of a worker that a run executes on, for example a local process, a
  thread, or an LLM chat session.
- **Cancellation** — a best-effort abort of a run. The engine only asks: it kills the child process
  and tears down the processor. It holds no deadline and no force path. There are three **causes**.
  **operator** is a cancel request against a root run. **sibling-failed** means a parallel branch
  failed, so the engine cancels its in-flight siblings. **sibling-succeeded** means a `wait-one` branch
  reached `succeeded`, so the engine cancels the still-running losers of the race (mvp spec §5.6). A
  cancelled run ends with the `cancelled` status. This status is distinct from `failed`: an operator
  that stops a run is not the workflow breaking. A cancelled run lands no publishes. A `run-cancelled`
  log event describes it and carries its cause.
- **Workflow** — a composition of steps. A workflow is itself a valid step type ("workflow-as-step").
  Thus to execute a workflow is to run the task of the step that wraps it. An implicit root step wraps
  the top-level workflow. The run of a workflow-step spawns **child runs** for its inner steps. These
  runs form a **run tree**.
- **Run tree** — the tree of runs that one **root run** spawns. The run of a workflow-step spawns child
  runs for its inner steps (workflow-as-step). Those runs recurse. Thus the runs under one root form a
  tree. Each run's parent run id is the key. The audit rows mirror the tree: every row carries a parent
  id and a root id. The disk layout `.path/runs/<root-run-id>/<run-id>/` also mirrors it. One shared
  primitive in `@path/schema` builds and walks the tree from the flat rows (`childrenByParent`,
  `subtree`, `findRootRun`). The engine's read-time cost SUM and a client's nested view read the same
  tree. They do not read two hand-rolled trees.
- **Run kind** — which of four shapes a run row is. `@path/schema` classifies it in one place
  (`runKind`, with `isRootRun` and `isReuseRow`). A **root run** has no parent run id. A **nested
  workflow-run** is the run of a workflow-step; it carries no worker. A **leaf step** is the run of any
  leaf step type — `binary`, `prompt`, or any plugin folder; it is the only kind bound to a worker.
  `binary` and `prompt` are two such folders, not a privileged pair. A **reuse row** is part of Resume
  (below). The
  `runs` table is one flat row shape across all four kinds. `runKind` names the distinction. Scattered
  null-checks (`parentRunId === null`, `reusedFromRunId !== null`) used to re-derive it at each reader.

## Step-type plugins

- **Step-type plugin** — a folder under `packages/engine/step-plugins/` that contributes one new **leaf
  step** type: its own extra fields, bundled with the type's named **workers**. The folder name *is* the
  type name: an `api-call` plugin makes `api-call` a first-class leaf step type, peer to `binary` and
  `prompt`. The folder states the type name nowhere else, so it cannot disagree with itself. The engine
  discovers and registers plugins before it validates a workflow, so a built-in and a plugin type are
  indistinguishable to a workflow author — `binary` and `prompt` are themselves plugin folders, not a
  privileged kind beside them. One directory holds every plugin, which is why no plugin can shadow
  another and no precedence order exists. Control constructs (parallel, branch, while-do, sequence,
  checkpoint) stay engine-owned and are never plugin-contributed: their names are **reserved**, and a
  folder claiming one is refused (map #308, ADR 0019). A workflow file that names a plugin type is
  **portable within a fork lineage, not across forks**: PATH's distribution is clone-or-fork, so the
  plugin a file needs lives in the reader's own PATH tree. A plugin type is therefore the second thing
  that is brittle across machines, beside the **relative-path** of source-workflow identity (Identity).
  The file's **id** stays portable; only its loadability was ever environment-relative. A file declares
  no dependency block — the `type` values in its body *are* its dependency list — and it can pin no
  plugin version: a version is **observable, never requirable** (#315). A plugin in fact **declares no
  version** at all (ADR 0023, #324): nothing resolves against one, so the unit of versioning is the
  **fork** — a folder's identity and history are a git commit in the reader's own tree, and a tree holds
  one folder per name, so exactly one version of a type is ever present. `api-call-v2` is a different
  type, not a second version; a removed type surfaces as the registry's load-time error, not a migration.
- **Step-plugin registry** — the set of loaded step-type plugins, injected as data into schema
  validation before any workflow parses. The engine builds it (it owns plugin discovery); `@path/schema`
  only receives it, so the schema package stays a pure function of its inputs with no filesystem access.
  Each entry carries that type's *extra* fields, its named **workers**, and which worker is the default;
  the schema layer adds the shared step envelope (`id`, `name`, `config?`, `input?`, `parse?`,
  `publish?`), the `worker` selector typed to that type's own worker names, the discriminant, and
  strictness, so a plugin cannot declare those wrong. A workflow that names a type the registry does
  not hold fails to load with a legible error that names the type, the same stance as an unset
  `$env` variable. The registry holds *every* leaf step type there is — `binary` and `prompt` included,
  since they are plugin folders like any other — so the set of valid step types is a fact about what is
  installed, not about the schema. `@path/schema` reproduces exactly the grammar its registry describes,
  and an empty one describes no leaf steps at all. Thus **validity is registry-relative**. A workflow
  file is valid *against a registry*, never in the abstract: the same bytes load where the plugin is
  present and fail where it is absent, and both verdicts are correct. There is no registry-free notion
  of a valid workflow file, which is why a consumer that cannot scan the folder — a browser design
  surface, say — **receives** a registry as data rather than assuming one (#315).

## Composition

- **Workflow body** — an ordered sequence of **nodes**. A node is a step, a parallel block, a branch
  block, a while-do block, a sequence block, or a checkpoint. Blocks nest without limit (the *nested
  block grammar*). Under `path/workflow@2`, every container slot holds exactly one node. A `sequence`
  carries the node array where a slot needs several nodes in order. Checkpoints can appear anywhere in
  a sequence.
- **Logicer** — an engine-evaluated control construct that routes and coordinates step execution. The
  block grammar realizes it. collect, wait-one, and do-not-wait are **join modes of the parallel
  block**. branch, while-do, and sequence are **block types**. A logicer has no worker, no task, and no
  run. The engine of the enclosing workflow evaluates it. (Spell it *logicer*.) The MVP subset has
  **four logicers** under `path/workflow@2`. The first is parallel (with its collect, wait-one, and
  do-not-wait joins). The second is branch. The third is while-do; it needs a mandatory max-iterations
  bound, and the run fails if it exceeds the bound. The fourth is sequence; this block type carries the
  node array wherever a single-node slot needs several nodes in order
  ([ADR 0014](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0014-single-node-container-slots-and-sequence-logicer.md)).
  The subset grew from three to four when `@2` made every container slot hold one node. `checkpoint`
  sits beside the logicers, not inside them (below). No "special node" term exists. All three joins have
  shipped.
- **Join mode** — how a parallel block resolves its branches. **collect** waits for every branch. It
  lands every branch's buffered publishes at the join. It outputs `{branch-node-name: output}`
  deterministically. **wait-one** races the branches. The **first-to-succeed** branch wins. The engine
  ignores a branch that fails and continues the race. It cancels the still-running losers (cause
  `sibling-succeeded`). The join lands the **winner's buffered publishes only**. The block outputs
  `{winner: {name, output}}`. If all branches fail, the block fails with an aggregate error. collect
  rejects same-key sibling publishes (a real last-writer race). wait-one allows them (only the winner's
  publishes land). **do-not-wait** launches every branch and waits for none at the join. The block
  completes at once with output `{}`. The successor runs while the branches continue. The engine awaits
  each branch at the enclosing-workflow-run barrier, so the tree stays strictly nested. A detached
  branch **must not publish**; it is a load error, because the branch lands after its readers. A failed
  detached branch is **isolated**: the engine records it on its own row and does not fail the tree
  ([ADR 0008](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0008-do-not-wait-detached-failure-does-not-fail-tree.md)).
  It adds **no new cancel cause**. Resume **re-fires** a non-succeeded detached branch with no
  short-circuit
  ([ADR 0009](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0009-do-not-wait-resume-re-fires-no-short-circuit.md)).
- **Checkpoint** — an engine-evaluated assertion node. It is a fail-fast gate. It mechanically tests
  data or context (format, presence, ranges, exit codes). If the test is true, the workflow continues.
  If the test is false, the run stops as failed. A checkpoint has no worker. It never exercises
  judgment. Any check that needs judgment (human or LLM) is a normal step that outputs a verdict,
  followed by a checkpoint that tests the verdict (the *judge-step pattern*). Compare `assert` and
  `if`: a branch routes, a checkpoint asserts.

## Identity

- **Id** — the stable GUID (UUIDv4) that the workflow and every node carry. It is the *machine*
  identity: unique by construction, assigned once, never regenerated. It is the audit `node_id` that a
  run row and a log event carry. It is the key that **resume** matches on: a successor node reuses a
  predecessor run by shared id (`plan-reuse`). Thus a rename or a move of a node never breaks reuse.
  The format requires it (`path/workflow@2`). A missing id is a load error, not a silent auto-stamp. A
  one-time codemod stamped every pre-existing file (Store note, ADR 0006, ADR 0007). Under `@2`, a
  branch **is** a node. The container change collapsed branch-identity into the node. Thus "and branch"
  is gone: every slot occupant carries its own `id` (ADR 0014).
- **Name** — the human label that the workflow and every node carry (`^[a-z][a-z0-9-]*$`, unique across
  a file). It is the *readable* identity. It is the key of a `collect` or `wait-one` output object
  (`{branch-node-name: output}`, and `wait-one`'s `{winner: {name, output}}`). It is the node that the
  log stream describes. It is the display and filter key in `path runs list`. It was formerly the
  node's `id` field. The GUID took the `id` name, and the human string moved to `name` (ADR 0006). It
  is carried into the audit layer as **`node_name`**. This field sits on both the run row and the
  log-event envelope, beside the GUID `node_id`. Thus a run tree and a log stream read human-legibly
  without a re-load of the workflow (ADR 0007).
- **Source-workflow identity** — the `{id, name, relative-path}` trio recorded once on a **root run**.
  It names the `workflow.json` that produced the run. The **id** is the durable grouping key, stable
  across runs and machines. The **name** is the display and filter key. The **relative-path** is the
  path relative to the store dir; it is provenance (where the file sat), it is brittle across machines,
  so it is never the identity. It is stored root-only, because nested rows already carry `node_id` and
  `worker`. It is what lets a relocated **store** segment an otherwise anonymous pile of run-ids by
  workflow.

## Invariants

1. Only steps execute on workers. Logicers and checkpoints are engine constructs: no worker, no task,
   no run.
2. Every execution is a run of a task. There is no separate "workflow execution" concept
   (workflow-as-step).
3. One step has exactly one input object and one output object.
4. Config flows in from outside (author or operator). Context is written from inside (steps at
   runtime).
5. A step inherits config downward from the enclosing workflow, unless the step overrides it. Worker
   does **not** inherit: a worker name is type-scoped, so a step selects its own by name or takes its
   type's default (#309).

## Relationships

```
Workflow ──body──> sequence of Nodes (Step | Parallel | Branch | While-do | Sequence | Checkpoint)
Step ("what") + Worker ("how", a named run method) = Task
Task ──executing instance──> Run  (on a Processor = live Worker instance)
Workflow-as-step: a workflow-step's run spawns child runs → run tree
Config ──injected into──> Run (per step, inheritable)
Context ──shared blackboard──> all steps of one workflow-run (isolated per workflow-run)
```

## Data

- **Type field** — a step type's own author-fixed datum, declared by the type and written on the node. It
  is **operator-invariant**: the same for every operator and every run. It says *what the step does*
  (`binary`'s `command` / `args` / `cwd`, `prompt`'s `prompt`, `api-call`'s `endpoint` / `method`). It is
  interpolable (`${config.x}`, `${context.y}`) and author-written per step. It is the counterpart of
  **Config** across the operator-invariance line: a datum fixed on the node is a field; a datum injected
  from outside is config. A type declares its fields as a typed fragment, validated at **load**. A field
  holds no `$env`/`$secret` wrapper (secret-bearing data enters only through config, **Secret**); it may
  still interpolate `${config.token}`, masked by value. A type also declares a typed **Config** fragment
  beside its fields (ADR 0022).
- **Config** — key-value data injected into a run *from outside*. The workflow author or operator
  supplies it at design or launch time (API tokens, model names, flags). It is the **operator-variable**
  counterpart of a **Type field**: injected, inheritable, and operator-overridable, where a field is
  author-fixed on the node. The sharp test is not "does the user type it at launch" but "is it injected
  from outside": `model` is config because it is inheritable and operator-overridable, even though an
  author writes it at the file top and no user supplies their own. You declare it per step. When you do
  not, the step inherits it from the enclosing workflow ("upper config inherited by downside steps").
  Config never comes from a step's execution. A step type declares the config keys it needs as a typed
  **open** (passthrough) fragment, some keys required (a required key is a non-optional key, ADR 0021's
  `prompt.model` the first case); the fragment is validated at **run-start** on the effective merged
  config, after `$env`/`$secret` resolution, before the first step (ADR 0022).
- **Operator config** — the subset of config that an *operator* supplies at launch to override authored
  values. Sources are the CLI `--config` and `--set`, and the `POST /v0/runs` `config` field. It is
  the opposite of config authored into a `workflow.json`. Its trust source is the launching operator,
  not the machine. It can carry a literal **Secret**. But it must not name the server's environment
  with an **Env-sourced value**. Otherwise a browser operator who launches a discovered workflow could
  read the server box's environment. A `$env` authored inside a workflow file is not affected: that
  value is the author's, not the operator's.
- **Context** — key-value data written *from inside* the run. Steps produce it at runtime. The other
  steps of the same workflow can read it (a computed temp dir, a branch name, accumulated results). It
  is scoped to one workflow-run and isolated. A nested workflow-step starts with a fresh, empty
  context. It exchanges data with its parent only through its input and output objects.
- **Publish set** — of a node: the set of `publish` keys declared on that node, plus the publish sets
  of every node reachable through its child bodies (the nested block grammar), through any depth of
  nesting. It **excludes** the file that a nested `workflow` step refs, because that file has its own
  isolated context. It is the scope over which the load-time publish checks apply. Under a `collect`
  parallel, the publish sets of two **concurrent** sibling branches must be disjoint; a same-key
  last-writer race is a load error. `wait-one` lifts that ban, because only the winner lands. A
  `do-not-wait` branch's publish set must be **empty**, because the branch lands after its readers.
  Within a single branch a key can recur (sequential steps, deterministic last-writer). It does not
  collide with itself.

Rule of thumb: **Config flows in from outside. Context is written from inside.**

## Audit

- **Observation** — one typed record of run activity that the engine emits to its **observer**. It is
  the full set and the engine's only audit seam. An observation carries its payload (`input`, `output`,
  `context`, `stderr`), because persistence writes those to blobs. Three of them (`step-stderr`,
  `step-usage`, `context-changed`) exist for persistence alone and are never narrated. The engine masks
  every observation for secrets before it crosses the seam. The engine masks at one emit point. Thus
  masking is not something an observer or a wrapper can be partial about.
- **Emitter** — the run-scoped producer of **observations**. The engine builds one per workflow-run
  from the run's identity. It owns the shared envelope, so a call site declares only what a given
  observation adds. It holds `run_id` and `root_run_id` for the run tier. It pulls `node_id` and
  `node_name` off the node for control-node observations. It computes the root-only run-started extras
  (source-workflow identity, `resumed_from_root_run_id`) from the run's own identity. Thus the code
  threads the `node_id` and `node_name` audit fields (ADR 0007) here, not at each site. A leaf step
  takes a **step-scoped** sub-emitter. This sub-emitter mints the step run's own `run_id` once. It
  carries that id across the step's `step-started`, then `step-usage` and `step-stderr`, then
  `step-finished`. The emitter sits *above* the mask point (Observation): it composes the record, and
  the single emit choke point masks it. One emitter, one envelope. Thus an identity-shape change lands
  in one module, not in every observation literal.
- **Log event** — a **narrated observation**. It is the append-only subset that reaches a **log
  backend**, with payloads stripped (they are reachable as blob refs on the run row). The event set
  covers step lifecycle (`step-started`, `step-finished`) and control-node activity (`branch-taken`,
  `branch-no-match`, `checkpoint-passed` and `checkpoint-failed`, `iteration-started`, `loop-exited`,
  `join-applied`, `run-cancelled`). The shared envelope has `seq` (monotonic per root run, the ordering
  truth), `ts`, `type` (a flat discriminated union), `run_id`, and `node_id`. The projection is not
  one-to-one. A workflow-run's own start and a leaf step's start are both `step-started` (invariant 2).
  The two finishes are alike. One `checkpoint-evaluated` observation becomes `checkpoint-passed` or
  `checkpoint-failed`. The log stream is the complete chronological narrative of a run tree. Run rows
  remain the authoritative queryable step record.
- **Trace** — the per-predicate evaluation record that condition-bearing log events carry. It is the
  condition tree, annotated with each leaf's dot-path, its outcome (`true`, `false`, or `error` plus a
  message), and the actual value read (post-masking).
- **Log backend** — a dumb sink that implements `open`, `write`, and `close`. The engine instantiates
  one per root run. The engine serializes the writes. It delivers fully-formed, already-masked events.
  Fan-out to multiple backends is engine-level configuration (the MVP default is a SQLite log table
  plus a per-root-run NDJSON file, both on). A backend write failure fails the run.
- **Env-sourced value** — a config value wrapped as `{"$env": "<NAME>"}`. It is sourced from the
  environment. The engine reads it once at run start (`@path/schema` never reads it, because that
  package owns only the shape and the walk). It composes with **Secret** by nesting:
  `{"$secret": {"$env": "NAME"}}` is a value both sourced and masked. Resolution runs *before* the
  masker collects, because masking is by value. A variable that is not set fails the run before its
  first step. One failure names every unset variable. The check covers every config object of the whole
  loaded tree, so a declaration that a parent's config shadows still counts. An empty variable is a set
  one.
- **Secret** — a config value wrapped as `{"$secret": ...}`. Secrecy rides the value through
  shallow-merge inheritance. The engine scrubs every secret value from all persisted artifacts (log
  events, input and output objects, `context.json`, the error that a failed `step-finished` carries,
  stderr, condition **trace** values) at the persistence boundary. It replaces the value with
  `[secret:<key>]`. A failed run records its error in the log stream alone; the run row carries the
  status and no error. (The text can still reach `stderr.txt`, because a binary step's error is its
  stderr tail.) That boundary is the engine's emit of an **observation**: one choke point that every
  observation passes through, not a wrapper that a caller applies. Workers receive real values, because
  masking is an audit-surface concern, not a dataflow restriction. What a finished run hands back to its
  caller is scrubbed too; the CLI and the server both print it to a terminal that in CI is a retained
  log. There is one exception, and it is the rule's point. A **succeeded** run's output is the product,
  and an operator is owed the real answer. A failed or cancelled run has no output contract, so the
  engine masks its returned output like its error. A thrown *bug* escapes the *failed-run contract*: the
  engine re-throws it rather than swallow it into a failed run. It no longer escapes the masker, which
  scrubs the message on the way out (ADR 0020). Two limits remain, and they are limits, not holes to
  plug. A worker that **mints** a new secret at runtime — an access token exchanged for a `$secret`
  client secret — holds a value the masker never collected, the same class as a transformed secret. And
  a **Worker** is in-process, so whatever it writes to a process stream bypasses the choke point
  entirely; the sanctioned channel is the `stderr` it returns, which becomes an observation like any
  other.

## Store

- **Project directory** — the directory whose `.path/` subtree is the **store** for a run. The store
  holds `path.db` (the run rows and log events) plus per-run blobs under
  `runs/<root-run-id>/<run-id>/`. You choose it per command; it is not baked into a workflow. The
  default for `path run` is the workflow file's own directory (it runs one file, in place). `path run
  -C <dir>` and `path runs -C <dir>` override the default; they point the command at a `.path` store
  elsewhere. `-C` is **store-only**: it moves where `.path` lives and nothing else. The `workflow.json`
  positional still resolves against the real working directory; it is never re-rooted under `<dir>`
  (contrast `git -C`). A relocated store is how one central directory holds runs from many workflows.
  Each root run records its **source-workflow identity** (Identity): the producing workflow's id, name,
  and store-relative path. Thus a shared store segments its runs by workflow instead of a list of
  anonymous run-ids.

## Discovery

- **Root workflow (file)** — a discovered `*.workflow.json` that no *other* discovered workflow refs as
  a nested `workflow` step. The distinction is **referential**. It is not about validity or
  launchability. A **nested-ref file** (one reachable from another through `ref`) is an equally complete,
  schema-valid workflow. It is launchable on its own with the right input and config
  (workflow-as-step). "Root" here names a file's position in the discovered ref graph. It is distinct
  from a **root run** (an execution's top run) and from the implicit **root step**. Workflow discovery
  lists *both* kinds and flags each as root or nested. It reports existence, validity, and root-ness. It
  promises nothing about standalone launch-readiness (ADR 0011, server-api-v0.md §6). The validity it
  reports is **registry-relative** (Step-type plugins): a file naming a step type this tree holds no
  plugin for is reported **invalid**, not valid-but-unlaunchable, because it is invalid against the only
  registry this tree has (#315).

## Resume

- **Root run** — a run tree's own top run. It is the run of the workflow's implicit root step
  (Composition, "Workflow"), the one with no parent run id. Its id is what `.path/runs/<root-run-id>/`
  and a log event's per-root `seq` (Audit, "Log event") key off.
- **Successor run** — a resumed tree's own root run. It has a fresh root run id, distinct from the tree
  it resumed. The predecessor tree becomes permanent and read-only the instant a successor starts. The
  engine never mutates, appends to, or reopens it. Whatever the successor needs from the predecessor (a
  reused node's output, a restored context, usage or cost figures) is read once at the point of reuse
  and referenced from then on. It is never copied.
- **Resumed-from** — a successor run's own record of which root run it resumed from. It is always the
  *immediate* predecessor, one hop. This holds regardless of how far back the data it actually reuses
  lives.
- **Reuse-marker** — a log event on a successor run's stream. For one reused node, it names the original
  run that holds that node's real data. It is direct-to-source: it skips any predecessor tree that never
  held that node. Thus every reuse-marker is a single, always-true hop, independent of how long the
  resumed-from chain runs.
- **Reuse row** — the run row that a successor tree writes for a reused node (#257). It is a real
  `succeeded` row, so the node appears in the **run tree** (`path runs`, the viewer). A chained resume
  can reuse it straight from `runs`. But it owns no execution of its own. It carries
  `reused_from_run_id`, the source run whose recorded output it reuses **direct-to-source** (never the
  immediate predecessor, ADR 0001). It has no worker, usage, or cost; the spend lives under the source
  and is never double-counted. Its input and output blobs live under the source too. The archive
  resolves the row's I/O refs to the source's on read. `reused_from_root_run_id` names the source's
  tree, and it synthesizes both refs to address the source's blobs. Thus a reuse row reads as one that
  *has* input and output, not one with none. If the source tree was since `rm`'d, the archive resolves
  both to null, because the data is genuinely gone. The **Reuse-marker** log event still fires alongside
  the row. It stays the record that the cost SUM (§5.7) and the `rm` guard read. The row is additive,
  not a replacement for the marker.
- **Live (tree)** — a root run whose rows still exist in `runs` (that is, `path runs rm` or `prune` has
  not yet removed them), regardless of its own status. A **succeeded** successor is still live. Its
  reuse-marker and the §5.7 cost-SUM traversal keep reaching into the original tree for as long as the
  successor tree itself exists, not just while the successor runs. Liveness is what the block-by-default
  check of `path runs rm` tests for (resume-run-identity.md).

## Surfaces

- **Viewer** — the client surface where runs are **watched**. It is the `@path/viewer` bundle: it
  discovers and launches a workflow, then follows its run — status, the run tree, per-node input and
  output — over the server's read and SSE routes. It authors nothing.
- **Designer** — the client surface where a workflow is **authored**, as against the Viewer where runs
  are watched. It is the `@path/designer` bundle, a peer of the Viewer over the same `@path/client-core`
  (ADR 0028). The author edits a workflow on a node canvas constrained to the block grammar and saves it
  through the server's write route; the Designer also carries its own run surfaces, shaped to the
  authoring loop, so a run never leaves it (ADR 0025). Its normative contract is
  [docs/spec/designer-spec.md](docs/spec/designer-spec.md).
- **Buffer** — the Designer's in-memory node tree for one open workflow file. One open file has one
  buffer; a descended nested-`workflow`-ref child is a separate open file with its own buffer, its own
  edit lease (ADR 0017), and its own undo stack. A buffer is what the canvas edits; a save serializes it
  through the write route.
- **Baseline** — the on-disk bytes (and their ETag) a **Buffer** last synced with: its last successful
  open or save. It is what the write route's `If-Match` precondition carries (ADR 0016) and the value a
  buffer is compared against to decide clean-versus-dirty. A `200` save advances it; nothing else moves it.
- **Save-point** — the moment a save advances the **Baseline**. A buffer is **clean** when its canonical
  serialization is byte-identical to the baseline (a content relation, not a mutation flag), and **dirty**
  otherwise. One save-point serves three consumers the same way — launch gates on clean, the `If-Match`
  precondition sends the baseline ETag, and the lease heartbeat beats unconditionally beside them
  (ADR 0025, ADR 0030).
