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
  when you do not, the step falls to a **worker-default** for its type if one is set — a **launch
  worker-default** first, then a **file worker-default** — and finally to its type's **default
  worker**. There is no worker inheritance: a
  type-scoped name is meaningless across types, so shared data like `model` travels through config
  instead. A worker-default is a *selection* among a type's already-scanned workers by name, so it is
  an operator affordance, unlike **workerOverrides**, which *replaces the code* of a `(type, name)`
  pair and stays host-only (ADR 0021 sub-15). A worker's `run` is in-process TypeScript loaded into the engine, so a worker is
  **author-trusted code** at the level of PATH's own source: it
  holds every **Secret** of the run and not only its own step's, and to add one is to edit the engine
  (ADR 0020). Two rules follow from that trust, and review is what enforces them. A worker reports
  diagnostics by *returning* `stderr`, never by writing to a process stream. And it reads the
  environment only through a resolved **Env-sourced value**, never `process.env` directly, because that
  is the door an operator's config is checked at (ADR 0012). One recorded exception: a shipped `prompt`
  worker's **provider credential** — `deepseek` reads `config.DEEPSEEK_API_KEY` first and
  `process.env.DEEPSEEK_API_KEY` second (ADR 0045).
- **Default worker** — the worker a step of a given type uses when it names none and no **worker-default**
  overrides it. Each step type declares exactly one (`binary`'s `spawn`, `prompt`'s `sdk`). Most steps use
  it and write no `worker` field. It is a required key on the type, not a reserved worker name. It is the
  bottom of the four-tier resolution: `node.worker` beats a **launch worker-default**, beats a **file
  worker-default**, beats this.
- **Worker-default** — a `{ <type>: <worker-name> }` table that sets which worker a type's *un-pinned*
  steps use, chosen among that type's already-scanned workers by name. It never names or adds code, so it
  is a selection, not a **workerOverrides**. A table naming an absent type, or a worker a type does not
  ship, is rejected registry-relative, and the two tiers fail through **two channels** (#506). A **file
  worker-default** fails as **file-invalidity**: its check is a registry-fed refinement at engine load, so
  discovery reports the file invalid and the Designer refuses to open it, beside an unknown `node.worker`
  or step type (ADR 0026); a bad child table invalidates the child file, not its parent, because the table
  is file-scoped. A **launch worker-default** fails at the **launch boundary**: the CLI exits non-zero and
  the server returns `400`, because it is operator input authored in no file and seen by no Designer, so
  the operator fixes it at launch where an author fixes a file. Both channels **aggregate** — one verdict
  names every bad entry (like an unset `$env`) — and each error names its source and lists either the
  installed types (absent type) or the type's shipped worker names (absent worker). Two
  tiers exist, and a node's own `worker` still beats both. A **file worker-default** is authored as a
  top-level `worker_defaults` key on a workflow file; it is **file-scoped** (it never crosses into a
  nested `workflow`-ref file, which carries its own) and is **live**, re-read from the current file on
  resume like every other authored datum. A **launch worker-default** is supplied by the operator at
  launch; it is **run-wide** across every file of the run — so it reaches a nested `workflow`-ref file's
  un-pinned steps and beats that file's own worker-default there, with only a node's `worker` pin above
  it — and **frozen** with the run, so a resume reuses it verbatim — it is identity-defining like
  **input**, not re-overridable like operator **config**.
  Changing it is a new run, never a resume.
- **Input** — the root run's starting context seed: one JSON object whose top-level keys become the
  root context. There are two sources, and the launch-time one wins. An **operator input override** is
  supplied at launch (the launch form's `Override input (optional)`, the wire `input` field); a **file
  input** is the workflow file's own optional top-level `input` key, its default seed. An override takes
  effect when it has at least one top-level key; a blank field, a literal `{}`, or an omitted field
  falls back to the file input, and to `{}` when the file declares none. The resolved value is what the
  run records and freezes — like a **launch worker-default**, input is identity-defining, so resume
  carries none and changing it is a new run. The file input seeds the root run only; a nested
  `workflow`-ref run's context comes from its parent step's input, never from the child file's own
  `input`.
- **Task** — a step bound to a worker. `task = step + worker`.
- **Run** — one executing (or executed) instance of a task. It is the only execution term in PATH.
  There is no separate "workflow execution" concept.
- **Processor** — one live instance of a worker that a run executes on, for example a local process, a
  thread, or an LLM chat session.
- **Cancellation** — a best-effort abort of a run. The engine only asks: it kills the child process
  and tears down the processor. It holds no deadline and no force path. There are three **causes**.
  **operator** is a cancel request against a root run. **sibling-failed** means a parallel branch
  failed, so the engine cancels its in-flight siblings. **sibling-succeeded** means a `wait-one` branch
  reached `succeeded`, so the engine cancels the still-running losers of the race (mvp spec §5.6).
  Both sibling causes reach a still-**Awaiting** leaf too: a parked person-activity branch is cancelled
  like any other non-terminal loser, and its later Complete lands `409` (ADR 0042). A
  cancelled run ends with the `cancelled` status. This status is distinct from `failed`: an operator
  that stops a run is not the workflow breaking. A cancelled run lands no publishes. A `run-cancelled`
  log event describes it and carries its cause.
- **Awaiting** — a non-terminal run status a **leaf step** holds while it waits for an external human
  action (a **person-activity** step, #462). The leaf's worker returns `{ status: "awaiting" }` and the
  run suspends until a person completes the offline activity and presses Complete. It is reached only
  from `running`. It leaves in one of two ways: a valid Complete (output that validates against the
  step's `outputSchema`) moves it to `succeeded`; an operator Cancel moves it to `cancelled`. It never
  returns to `running` and reaches no terminal status by any other path. `isTerminal` returns false for
  it, beside `pending` and `running`. It does **not** propagate: a root run and every enclosing
  workflow-run stay `running` while a descendant awaits, and the awaiting-ness reads at the leaf that
  holds it, never rolled up to a parent (ADR 0038). It is distinct from debug's `paused` (waiting for a
  debugger, #419), which is not yet a run status; a run in `awaiting` waits for a person. A
  `step-awaiting` log event narrates the entry (Audit, "Log event").
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
- **Run kind** — which of six shapes a run row is. `@path/schema` owns the classification as four
  type-guards — `isRootRun`, `isReuseRow`, `isIterationRun`, `isPassRun` — each the one reader of its own field. A **root run** has no parent run
  id. A **nested workflow-run** is the run of a workflow-step; it carries no worker. A **leaf step** is
  the run of any leaf step type — `binary`, `prompt`, or any plugin folder; it is the only kind bound to
  a worker. `binary` and `prompt` are two such folders, not a privileged pair. A **reuse row** is part
  of Resume (below). An **iteration** is one repetition of a `while-do` loop (ADR 0037): a container run minted
  per iteration so the loop body's runs get a unique parent scope, told apart by its 1-based `iteration`
  ordinal. It is worker-less like a workflow-run but does **not** isolate context — the loop's shared
  blackboard stays the enclosing run's. A **pass** (Composition, ADR 0054) is the `goto` analogue: a
  container run per **Pass** of a top-level walk, told apart by its 1-based `pass` ordinal and named
  after the goto that opened it (no node for pass 1). The `runs` table is one flat row shape across all
  six kinds. The four guards name the distinctions the readers need. Scattered null-checks
  (`parentRunId === null`, `reusedFromRunId !== null`, `iteration !== null`) used to re-derive them at
  each reader.

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
- **Person-activity** — a built-in **leaf step** type (plugin folder `person-activity/`) that suspends a
  run for an external human action. Its single **worker** `person` (also the **default worker**) does no
  I/O and returns `{ status: "awaiting" }`; the run then holds the **Awaiting** status. It declares three
  **type fields**: `description` (required, interpolable — the instructions shown to the person),
  `outputSchema` (optional — a JSON Schema *object* describing the shape the person's completion output
  must satisfy; omitted means any JSON output is accepted), and `assignee` (optional, informational
  string, no enforcement). It declares no **config** keys in v1; the worker meters nothing and holds no
  processor slot. Awaiting is **durable**, not a held process: the run row persists with `status =
  awaiting` and no output blob, and the engine may tear down entirely, because a person can take days.
  Completion is therefore a *fresh engine invocation*, not a resumed held process (ADR 0039). `POST
  /v0/runs/:step_run_id/complete` carries the person's `output`; the engine reopens the same **run tree**
  (the appendable-tree mechanism, ADR 0041: a replay from the root that reuses succeeded rows and appends
  in place, not a new successor tree as Resume mints), restores **context**, reloads the workflow file, reads *this* node's `outputSchema`
  by node **id**, re-interpolates it against the run's config, and validates the submitted output with
  `ajv` (ADR 0040). Invalid output is **refused** (`400` with validation details) and the step stays `awaiting` for
  a retry; valid output is written as the step's output blob, the step moves to `succeeded`, and the run
  continues. The schema is read from the *current* file at completion, so the file is the authority: an
  author's edit to `outputSchema` between launch and Complete validates against the newer shape.
  `outputSchema` is thus both a **UI contract** (the **Viewer** and **Designer** build the Complete form
  from it) and a **validation contract** (Complete checks against it), and it lives in the workflow file,
  never on the run row. `parse: "json"` is a no-op for this type, because the Complete body already
  carries a structured `JsonValue` rather than a stdout string.

## Composition

- **Workflow body** — an ordered sequence of **nodes**. A node is a step, a parallel block, a branch
  block, a while-do block, a sequence block, or a checkpoint. Blocks nest without limit (the *nested
  block grammar*). Under `path/workflow@5`, every container slot holds exactly one node. A `sequence`
  carries the node array where a slot needs several nodes in order. Checkpoints can appear anywhere in
  a sequence.
- **Controller** — an engine-evaluated control construct that routes and coordinates step execution. It
  comes in exactly two kinds: a **Structure Controller** or a **Graph Controller**
  ([ADR 0057](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0057-controllers-split-into-structure-and-graph-kinds.md)).
  collect, wait-one, and do-not-wait are **join modes of the parallel block**. branch, while-do, and
  sequence are **block types**. A controller has no worker, no task, and no run. The engine of the
  enclosing workflow evaluates it. (Spell it *controller*.) The MVP subset has **five Structure
  Controllers** under `path/workflow@5`. The first is parallel (with its collect, wait-one, and
  do-not-wait joins). The second is branch. The third is while-do; it needs a mandatory max-iterations
  bound, and the run fails if it exceeds the bound. The fourth is sequence; this block type carries the
  node array wherever a single-node slot needs several nodes in order
  ([ADR 0014](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0014-single-node-container-slots-and-sequence-logicer.md)).
  The block-type count grew from three to four when `@2` made every container slot hold one node. The
  fifth Structure Controller is `checkpoint`; it is a controller too, not a block type (below). No
  "special node" term exists. All three joins have shipped.
- **Structure Controller** — a controller that the nested block grammar holds: single-entry,
  single-exit, output-threaded, and each node in its body visited at most once per entry. The five are
  `parallel`, `sequence`, `branch`, `while-do` and `checkpoint` (a grammar node with no body, so the
  rule holds trivially). A `while-do` repeats its body, but each iteration is a fresh entry into the same
  block, so the rule holds per iteration. Any structure that Structure Controllers build is a **tree**.
  _Avoid_: block controller, structural node.
- **Graph Controller** — a controller that adds routing the tree cannot express: it moves the walk to a
  node that is not its structural successor. `goto` *(planned, #478)* is the only one. It is an ordinary
  node in a slot, at the first level or inside a first-level `branch` arm, and its route is a **name**
  reference, not an edge, so the body stays a tree. Only one file's **top-level walk** follows the route
  ([ADR 0057](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0057-controllers-split-into-structure-and-graph-kinds.md)).
  `person-switch` is **not** a Graph Controller, and not a controller at all: it is a shipped
  **Step-Template** that composes a `person-activity` step and a `branch`, so it belongs to the
  Templates taxonomy
  ([ADR 0052](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0052-person-switch-is-a-shipped-step-template-not-a-controller.md)).
  _Avoid_: jump node, edge, DAG node.
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
  An **Awaiting** leaf inside a branch is an ordinary non-terminal branch member; a join invents no
  special case for it
  ([ADR 0042](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0042-awaiting-inside-parallel-joins.md)).
  Under **collect**, awaiting branches each resolve on their own Complete in any order; a sibling
  *failure* cancels the still-awaiting branches (cause `sibling-failed`). Under **wait-one**, an
  awaiting branch is a live racer: it wins if its Complete lands first, and it is cancelled (cause
  `sibling-succeeded`) if a sibling succeeds first. Under **do-not-wait** a person-activity step is
  legal only when its **publish set** is empty (the ordinary detached-branch rule, keyed on declared
  `publish` keys, not on completion output); a detached branch parked awaiting holds the
  enclosing-workflow-run barrier open, so the root stays `running` (ADR 0038). None of these adds a
  cancel cause; a never-Completed awaiting branch is non-succeeded, so Resume re-runs it and it parks
  afresh.
- **Checkpoint** — an engine-evaluated assertion node. It is a fail-fast gate. It mechanically tests
  data or context (format, presence, ranges, exit codes). If the test is true, the workflow continues.
  If the test is false, the run stops as failed. A checkpoint has no worker. It never exercises
  judgment. Any check that needs judgment (human or LLM) is a normal step that outputs a verdict,
  followed by a checkpoint that tests the verdict (the *judge-step pattern*). Compare `assert` and
  `if`: a branch routes, a checkpoint asserts.
- **Goto** — *(planned, #478)* the one **Graph Controller**. It sets the next step of the
  **top-level walk** to a named **first-level node** of its own file, backward jumps included, so a
  first-level node can run more than once in one workflow-run. A jump never crosses a `workflow`-ref
  boundary in either direction, so a target is always a first-level node of the goto's own file. A
  goto sits in any node slot whose ancestor chain holds no `while-do` and no `parallel` — the first
  level, a first-level `branch`'s arm or `else`, or any `sequence`/`branch` nesting below one — and
  its target is any other first-level node, never an inner node and never itself
  ([ADR 0058](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0058-a-goto-is-target-plus-max-jumps-in-path-workflow-5.md)).
  A goto names
  its **target** by the target node's `name`, never its `id`. Load refuses a target that names no
  node in the file, names an inner node, or names the goto itself, and refuses a goto under
  `while-do` or `parallel`. An unguarded first-level goto with a backward target is legal: another
  goto can jump past it to leave the loop
  ([ADR 0056](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0056-a-goto-names-its-target-by-step-name-checked-at-load-in-path-schema.md)).
  It jumps by
  returning a `goto` `SeqOutcome` that nested walkers pass up unchanged and only the top-level walk
  consumes. Its mandatory **`max_jumps`** (default 3, per goto node per workflow-run) bounds it like
  `while-do`'s max-iterations: exhausting it fails the run
  ([ADR 0053](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0053-goto-is-a-seqoutcome-jump-caught-by-a-per-file-top-level-walk.md)).
  A goto's jumps spent are the passes it opened in the workflow-run
  ([ADR 0060](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0060-complete-follows-the-record-across-closed-passes-and-jump-counts-are-pass-rows.md)).
  A goto carries no input of its own: the output it received passes through as the target's incoming
  output, forward or backward, and the target's own `input` map still wins
  ([ADR 0055](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0055-a-goto-target-is-seeded-by-the-gotos-passed-through-output.md)).
- **First level** — a file's own top-level body, as a position: the list a **top-level walk** steps
  through, per file. It is where a `goto` sits or targets, and where the resume prefix rule reads a K.
  A `while-do` iteration and a `parallel` branch are never first level, however shallow, and a nested
  `workflow`-ref file has its own. _Avoid_: top level (of a body), root level, depth.
- **Top-level walk** — how a workflow-run walks its file's top-level body: an index loop with a jump
  register, the only walk a `goto` can re-seek. Every nested body (`sequence`, branch arm, loop
  iteration, `parallel` branch) is walked by `runSequence` in strict order, one visit per node.
- **Pass** — one forward stretch of a **top-level walk**: from the start of the body, or from a jump
  target, up to the next jump taken or the end of the body. Within a pass the walk only moves forward,
  so each first-level node runs at most once. Only a workflow-run whose file holds a `goto` has passes,
  from pass 1 on, whether or not a jump is taken. Each pass is a container run with a 1-based ordinal,
  and every run made during that pass (first-level nodes and everything nested in them) hangs under
  it. It is the `goto` analogue of a `while-do` **iteration**: a run-identity and reuse scope that
  shares the workflow-run's context, not a context boundary. A Resume pairs a pass with the
  predecessor's pass of the same ordinal opened by the same goto, whatever its status; a mismatch runs
  that pass and every later one fresh
  ([ADR 0054](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0054-a-goto-visit-is-scoped-by-a-per-pass-container-run.md)).
  A Complete does not re-walk closed passes: it re-enters the one `running` pass in place by its
  ordinal, starting at its opening goto's target
  ([ADR 0060](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0060-complete-follows-the-record-across-closed-passes-and-jump-counts-are-pass-rows.md)).
  _Avoid_: visit, round (a visit is one node's run; a pass is the whole stretch).

## Identity

- **Id** — the stable GUID (UUIDv4) that the workflow and every node carry. It is the *machine*
  identity: unique by construction, assigned once, never regenerated. It is the audit `node_id` that a
  run row and a log event carry. It is the key that **resume** matches on: a successor node reuses a
  predecessor run by shared id (`plan-reuse`). Thus a rename or a move of a node never breaks reuse.
  The format requires it (`path/workflow@5`). A missing id is a load error, not a silent auto-stamp. A
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

## Templates

- **Template** — an **authoring artifact** that expands into ordinary nodes *before* any run. It is
  distinct in kind from a **Step-type plugin**: a plugin is code the engine registers and a step type it
  executes, while a template contributes no step type, ships no worker, and is never registered or
  executed. It is **Server-owned and engine-blind**: the Server reads it and the Designer inserts from
  it, and a run's engine never sees the template — only the ordinary nodes it produced, which are
  indistinguishable from hand-authored ones. Its file format is
  [ADR 0048](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md).
  That it is a **Server authoring artifact** and not a step-plugin at all — the engine never registers
  or executes it — is
  [ADR 0051](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0051-a-template-is-a-server-authoring-artifact-not-a-step-plugin.md).
- **Step-Template** — a Template that is a **fragment of a workflow body**: one, two, or more nodes,
  saved as a unit and insertable into an existing workflow. Its **default property values** are simply
  the values its own nodes hold — its body is a valid **Workflow body**, never a shape with placeholders
  for one, so it is always a literal parameterized snippet and never a form to fill in. It can be
  inserted only where its nodes are grammar-legal, and the author edits an instance's values afterwards
  like any other node's. It is the artifact behind the Designer's Step-Template palette category. Its
  name is its file name; its own `id` is its identity.
- **Workflow-Template** — a Template that is a whole workflow: an ordinary `*.workflow.json` whose name
  carries a `*.workflow-template.json` suffix. Unlike a Step-Template it is selectable **only** into an
  empty canvas (a Designer buffer whose body holds zero nodes), and the resulting **instance** is
  saveable **only** to a `*.workflow.json` (#460.3). Its identity is its own workflow `id`. Selecting it
  is **Instantiation** like a Step-Template's, plus a workflow-level re-mint: the new buffer gets a fresh
  workflow `id` (two workflows spawned from one template must not share a **source-workflow identity**,
  ADR 0006) and fresh node ids, while its `input` and `worker_defaults` ride across verbatim and its new
  name/path come from the save-as dialog (provenance, not identity, ADR 0006).
- **Instantiation** — the detached-copy transform a Template runs to become ordinary nodes, a pure
  function of the template body owned by `@path/schema` and called by the Designer client; the engine
  never sees it (a Template is engine-blind). It deep-copies the `body`, mints a fresh UUIDv4 `id` on
  **every** node recursively (leaf steps, containers, and every branch arm; ADR 0006), drops the envelope
  `id` (that GUID is the template's identity, ADR 0048), and keeps every other datum verbatim — values,
  `config`, `parse`, `publish`, `condition`, and each `workflow`-ref's `ref` string — because a `@2` body
  fragment holds no GUID cross-references, so a re-stamp needs no rewiring (#559). There is **no defaults
  pass**: a template's default property values *are* the values its nodes already hold (#561), and
  step-type field, worker, and config defaults stay the engine's registry-relative run-time job. A 2+-node
  body dropped into a single-node container slot is wrapped in a fresh `sequence`; a one-node body inserts
  bare; at the file-body top level or inside an existing `sequence` the nodes splice in directly. The
  Designer edit-tree checks grammar-legality of the drop target client-side and refuses an illegal drop.
- **Template instance** — the detached copy **Instantiation** produces. Its nodes keep the template's
  authored values verbatim and its authored **names** verbatim *until a name collides* with one already
  used in the target file, which the Designer resolves the way any new node's name does — `uniqueName`
  reserves `name`, then `name-2`, `name-3`, … (it keeps names file-unique by construction, though the
  schema imposes no uniqueness, #561). Every node **id** is freshly minted, because a GUID is unique by
  construction and the template's own GUIDs already belong to the template. There is no back-link in
  either direction: editing the template never propagates to an instance, and editing an instance never
  propagates back. **Two stated hazards** ride the verbatim copy. A name that gets uniquified breaks any
  intra-body **value-level** reference to it — a downstream `context.<name>...` dot-path, or a cross-block
  read of a renamed branch's `collect`/`wait-one` output key — because Instantiation does not rewire
  references (#559); insert a name-referential template into a file that already holds a colliding name at
  your own risk. And a relative `workflow` `ref` re-resolves against the *target* file's directory
  (#561), so a copied `ref` can point elsewhere when the template and target directories differ.
- **Template edit mode** — which of two modes the Designer is in decides where a save of template content
  lands, and the file suffix on open is the discriminator. **Consume mode** (a template selected from the
  palette into an empty canvas) yields an instance whose default Save writes a `*.workflow.json`; it
  becomes a template again only through an explicit "Save as template" (#459.6). **Author mode** (the
  `*.workflow-template.json` file itself opened to edit the template source) is ordinary file editing
  under the ADR 0015 round-trip, so its default Save writes **back to the original** template file with
  the workflow `id` preserved; a Save-As to a **new** `*.workflow-template.json` mints a fresh workflow
  `id` (two templates must not share identity), and a "Save as workflow" runs Instantiation to a
  `*.workflow.json`. Author-mode save rides the template write-route (#563); the Designer opens a
  template source from its palette card's Edit button (#580, designer-spec § Editing a
  Workflow-Template's source).
- **Template store** — where the Server keeps templates and how it resolves one. It is a
  **four-directory union** over two origins and two kinds:
  `packages/server/template/{step-template,workflow-template}/` holds the **shipped** templates
  (`read_only`, portable within a fork lineage) and `.path/template/{step-template,workflow-template}/`
  holds the **user** templates (writable, project-scoped). Each file's **kind** is read from its suffix
  (`*.step-template.json` vs `*.workflow-template.json`), never from its bytes. The Server builds one
  **id-index** across all four directories, so a single `:id` lookup spans both kinds and both origins (a
  GUID is globally unique,
  [ADR 0006](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0006-workflow-and-node-identity-guid-plus-name.md)).
  A duplicate id across origins lists **both** entries and flags the **user** one invalid; a template
  that fails to parse invalidates **only its own entry**, never Server start
  ([ADR 0048](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0048-the-step-template-schema-is-an-envelope-over-a-validated-workflow-body.md)).
  Reads serve the union; writes land in `.path/template/` alone. It is the substrate the **Template API**
  reads and writes, and because a template is Server-owned and engine-blind
  ([ADR 0051](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0051-a-template-is-a-server-authoring-artifact-not-a-step-plugin.md)),
  no run ever reads it.
- **Template API** — the `/v0/templates` routes the Designer reaches a **Template** through, since a
  template is Server-owned and engine-blind. Unlike a **Workflow**, which the write routes address by
  *path* because a run is launched by where the file lives (ADR 0016, §7), a template is **addressed by
  its GUID**: `GET`/`PUT`/`DELETE /v0/templates/:id`, where `:id` is a step-template's envelope `id` or a
  workflow-template's own workflow `id`. A GUID is globally unique (ADR 0006), so one lookup spans both
  kinds. The Server resolves `:id` through the **Template store** index (the shipped + user
  four-directory union, suffix-typed). `GET /v0/templates` lists that union **thin** (`id`, `name`,
  `description`, `kind`, `origin`, `read_only`, `valid`, `error`; no `body`) with an optional `?kind=`
  filter; duplicate-id and per-entry validity are the **Template store**'s (ADR 0048). `GET
  /v0/templates/:id` returns a **parsed envelope** plus an
  `etag` (sha256 of the on-disk bytes), not the raw bytes the workflow read serves (§7.1), because a
  template is never id-less. `POST /v0/templates` is **save-as** — create-only, writing a client-minted
  envelope to `.path/template/` alone, `409` on a name collision. `PUT /v0/templates/:id` is
  **update-only**, `If-Match`-gated, `403` on a shipped (read-only) target, `404` on an unknown id, and it
  cannot rename. It is the write door **author-mode save** rides: ADR 0049's "ordinary file editing
  round-trip" is this precondition-gated write, not a Workflow write. `DELETE /v0/templates/:id` removes a
  user template (`204`), `403` on shipped, `404` on unknown. The two write doors stay **disjoint**: `PUT
  /v0/workflows` refuses a `.path/template/` or `*.workflow-template.json` path, so a template is written
  only through this API and becomes runnable only by **Instantiation**. Fixed by
  [ADR 0050](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0050-the-template-api-is-id-addressed-and-owns-the-template-write-door.md);
  the endpoint surface is `docs/api/server-api-v0.md` §10.

## Invariants

1. Only steps execute on workers. Controllers, Structure and Graph alike (including `checkpoint` and
   `goto`), are engine constructs: no worker, no task, no run.
2. Every execution is a run of a task. There is no separate "workflow execution" concept
   (workflow-as-step).
3. One step has exactly one input object and one output object.
4. Config flows in from outside (author or operator). Context is written from inside (steps at
   runtime).
5. A step inherits config downward from the enclosing workflow, unless the step overrides it. Worker
   does **not** inherit: a worker name is type-scoped, so a step selects its own by name, else a
   **worker-default** for its type (launch before file), else its type's **default worker** (#309). The
   worker-default tiers **narrow** this invariant, they do not breach it: a default is a **selection** —
   a type-scoped name picked among a type's already-scanned workers — never an **inheritance**, which
   flows a *value* from a parent node down to a child by tree position. #309's reason survives: a name
   stays meaningless across types. A **file worker-default** is file-scoped and never crosses a nested
   `workflow`-ref boundary (each ref-file authors its own), so it is plainly a per-type selection. A
   **launch worker-default** is run-wide, so it does reach a nested `workflow`-ref file — not by
   inheriting from the parent file, but because the operator set one flat per-type table for the whole
   run, applied the same to every un-pinned step at any depth. Both tiers are selection, for two
   different reasons.

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
  value is the author's, not the operator's. It is **frozen with the run** as a [[Launch facts]] field,
  stored resolved and masked (a **Secret** value becomes its token), and restored by a Resume or a
  Complete — which is why a masked secret must be supplied again on the continuation.
- **Launch facts** — what an operator supplied at launch beyond the workflow file: an **input** override,
  an **operator config** override, and a **worker-default** table, frozen on the run tree's root row
  (ADR 0046). A Resume or a Complete recovers the config and the worker-default table; the input
  override is recorded and shown, never re-applied, because both continuations restore the **Context**
  blackboard rather than re-seeding it. A recovered secret value is only its `[secret:<key>]` token, so
  the continuation must supply it again — otherwise the run ends before its first step naming the key.
  All three facts are readable on the run-tree response; a root-run summary carries the masked secret
  *names* alone, so a Resume surface can ask for them before it submits.
- **Context** — key-value data written *from inside* the run. Steps produce it at runtime. The other
  steps of the same workflow can read it (a computed temp dir, a branch name, accumulated results). It
  is scoped to one workflow-run and isolated. A nested workflow-step starts with a fresh, empty
  context. It exchanges data with its parent only through its input and output objects. Within one
  workflow-run it is a single last-writer-wins blackboard: a `while-do` **iteration** and a goto
  **Pass** share it, and nothing is reset when a loop repeats or a `goto` jumps backward. A key that no
  node has published yet on the path taken is unresolvable when read, whatever the reason
  ([ADR 0059](https://github.com/howardyang2009/PATH/blob/main/docs/adr/0059-context-under-goto-is-one-last-writer-wins-blackboard-across-passes.md)).
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
  covers step lifecycle (`step-started`, `step-awaiting`, `step-finished`) and control-node activity
  (`branch-taken`, `branch-no-match`, `checkpoint-passed` and `checkpoint-failed`, `iteration-started`,
  `loop-exited`, `pass-started`, `join-applied`, `run-cancelled`). `step-awaiting` marks a step that suspended on an
  external completion (a **person-activity** step, #462); it carries no terminal status, so it is its
  own log event beside `step-finished`. It also carries the leaf's `assignee` (#488) — who the offline
  activity is for, `null` when the node named none — so an `awaiting`/Complete cycle reconstructs from
  the log alone (the Complete's `step-finished` closes it), not only from the mutable workflow file. The shared envelope has `seq` (monotonic per root run, the ordering
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
- **Rerun boundary (K)** — the node a Resume re-runs *from*. Nodes serialized before K reuse their
  succeeded results (reuse rows, direct-to-source); K and every serialized-later node re-run in the
  successor, each subtree entire. When K sits inside a nested `workflow` file, the boundary is a
  **descent path** root→…→K: at each level the nodes before the path-node reuse, the nodes after it
  re-run entire, and the path-node is descended into; only K itself re-runs entire. Thus at each level
  on the path every top-level node has one of three **dispositions**: **reuse** (before the
  path-node), **rerun-entire** (after the path-node, and the path-node itself when it is K), or
  **descend** (the path-node when it is an intermediate `workflow` node — re-entered with partial
  reuse under the next level's boundary). Intermediate path-nodes are `workflow` nodes by necessity;
  only K may be a leaf. Plain Resume is K
  at the **auto-boundary** — the first non-succeeded top-level node — so plain Resume is the K =
  auto-boundary case of one action, not a second path. The operator selects K by the **source node's
  run id**, the one unambiguous handle (a bare node id is file-scoped and cannot tell two refs of the
  same nested file, or two loop iterations, apart). The engine resolves that run id to the descent
  path of node **ids** by walking the source run's parents; the node-id path is the identity it
  **matches** against the current file (so a rename or move of a node survives, a delete fails) and
  **persists** on the successor beside **Resumed-from** (`rerunFromNodePath`, `{nodeId, nodeName}[]`,
  null on plain Resume). The path is also derivable from the successor's own rows — at each level the
  first child with a genuine-execution row, not a reuse row — so the persisted field is a
  denormalization for read, never load-bearing for correctness. The run-id selection is checked
  before the successor starts: a **legal K** resolves to a node still present in the current file,
  **succeeded**, at the **first level** of its own file's body, whose whole prefix `<K` also
  succeeded. A selection that resolves to no run in the source tree, to a since-deleted node, to a
  node inside a loop/parallel/branch body, to a node that did not succeed, or over a prefix that did
  not fully succeed is **refused** and no successor is created. Plain Resume omits the selection
  entirely. In a file with passes, K may be a first-level node inside pass N: passes before N reuse,
  pass N reuses the nodes before K, and K, the rest of pass N and every later pass re-run; the path
  entry for that level carries the pass ordinal (ADR 0054).
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
