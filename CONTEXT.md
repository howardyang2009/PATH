# PATH — Ubiquitous Language

Glossary for the PATH workflow management system. Terms here are canonical; code, specs, and issues use them exactly.

## Core execution model

- **Step** — the unit of work in a workflow. Has exactly one input object and one output object. A step declares *what* to do (its type and payload), not *who* does it.
- **Worker** — *who/where* a step executes: the binding to an execution capability (e.g. local engine, an LLM subagent). Declared per step; inherited from the enclosing workflow when unspecified.
- **Task** — a step bound to a worker. `task = step + worker`.
- **Run** — one executing (or executed) instance of a task. The only execution term in PATH: there is no separate "workflow execution" concept.
- **Processor** — one live instance of a worker that a run executes on (e.g. a local process, a thread, an LLM chat session).
- **Cancellation** — best-effort abort of a run: the engine asks (kills the child process, tears down the processor) and holds no deadline and no force path. Two **causes**: **operator** — a cancel request against a root run — and **sibling-failed** — a parallel branch failed, so its in-flight siblings are cancelled (mvp spec §5.6). A cancelled run ends `cancelled` (a distinct status from `failed`: an operator stopping a run is not the workflow breaking), lands no publishes, and is narrated by a `run-cancelled` log event carrying its cause.
- **Workflow** — a composition of steps. A workflow is itself a valid step type ("workflow-as-step"), so executing a workflow means running the task of the step that wraps it. The top-level workflow is wrapped in an implicit root step. A workflow-step's run spawns **child runs** for its inner steps, forming a **run tree**.

## Composition

- **Workflow body** — an ordered sequence of **nodes**; a node is a step, a parallel block, a branch block, a while-do block, or a checkpoint. Blocks nest arbitrarily (the *nested block grammar*); checkpoints may appear anywhere in a sequence.
- **Logicer** — an engine-evaluated control construct that routes and coordinates step execution, realized in the block grammar: collect, wait-one, and do-not-wait are **join modes of the parallel block**; branch and while-do are **block types**. A logicer has no worker, no task, and no run — the engine of the enclosing workflow evaluates it. (Spelled *logicer*.) MVP subset: collect join, branch, while-do with a mandatory max-iterations bound (exceeded → run fails); wait-one and do-not-wait deferred.
- **Checkpoint** — an engine-evaluated assertion node: a fail-fast gate that mechanically tests data or context (format, presence, ranges, exit codes). True → the workflow continues; false → the run stops as failed. A checkpoint has no worker and never exercises judgment — any check requiring judgment (human or LLM) is expressed as a normal step that outputs a verdict, followed by a checkpoint that tests it (the *judge-step pattern*). `assert` vs `if`: branch routes, checkpoint asserts.

## Invariants

1. Only steps execute on workers. Logicers and checkpoints are engine constructs — no worker, no task, no run.
2. Every execution is a run of a task; there is no separate "workflow execution" concept (workflow-as-step).
3. One step has exactly one input object and one output object.
4. Config flows in from outside (author/operator); context is written from inside (steps at runtime).
5. Worker and config are inherited downward from the enclosing workflow unless a step overrides them.

## Relationships

```
Workflow ──body──> sequence of Nodes (Step | Parallel | Branch | While-do | Checkpoint)
Step ("what") + Worker ("who") = Task
Task ──executing instance──> Run  (on a Processor = live Worker instance)
Workflow-as-step: a workflow-step's run spawns child runs → run tree
Config ──injected into──> Run (per step, inheritable)
Context ──shared blackboard──> all steps of one workflow-run (isolated per workflow-run)
```

## Data

- **Config** — key-value data injected into a run *from outside*: supplied by the workflow author or operator at design/launch time (API tokens, model names, endpoints, flags). Declared per step; when unspecified, inherited from the enclosing workflow ("upper config inherited by downside steps"). Config never originates from a step's execution.
- **Context** — key-value data written *from inside* the run: produced by steps at runtime and readable by the other steps of the same workflow (a computed temp dir, a branch name, accumulated results). Scoped to one workflow-run and isolated: a nested workflow-step starts with a fresh, empty context and exchanges data with its parent only through its input and output objects.

Rule of thumb: **Config flows in from outside; Context is written from inside.**

## Audit

- **Observation** — one typed record of run activity the engine emits to its **observer**: the full set, and the engine's only audit seam. An observation carries its payload (`input`, `output`, `context`, `stderr`), because persistence writes those to blobs; three of them (`step-stderr`, `step-usage`, `context-changed`) exist for persistence alone and are never narrated. Every observation is already **secret**-masked when it crosses the seam — the engine masks at one emit point, so masking is not something an observer or a wrapper can be partial about.
- **Log event** — a **narrated observation**: the append-only subset that reaches a **log backend**, with payloads stripped (they are reachable as blob refs on the run row). The event set covers step lifecycle (`step-started`, `step-finished`) and control-node activity (`branch-taken`, `branch-no-match`, `checkpoint-passed`/`-failed`, `iteration-started`, `loop-exited`, `join-applied`, `run-cancelled`). Shared envelope: `seq` (monotonic per root run — the ordering truth), `ts`, `type` (flat discriminated union), `run_id`, `node_id`. The projection is not one-to-one: a workflow-run's own start and a leaf step's start are both `step-started` (invariant 2), the two finishes likewise, and one `checkpoint-evaluated` observation becomes `checkpoint-passed` or `checkpoint-failed`. The log stream is the complete chronological narrative of a run tree; run rows remain the authoritative queryable step record.
- **Trace** — the per-predicate evaluation record carried by condition-bearing log events: the condition tree annotated with each leaf's dot-path, outcome (`true` / `false` / `error` + message), and the actual value read (post-masking).
- **Log backend** — a dumb sink implementing `open`/`write`/`close`, instantiated per root run. The engine serializes writes and delivers fully-formed, already-masked events; fan-out to multiple backends is engine-level configuration (MVP default: SQLite log table + per-root-run NDJSON file, both on). A backend write failure fails the run.
- **Env-sourced value** — a config value wrapped as `{"$env": "<NAME>"}`: sourced from the environment, read once at run start by the engine (never by `@path/schema`, which owns only the shape and the walk). It composes with **Secret** by nesting — `{"$secret": {"$env": "NAME"}}` is a value both sourced and masked — and resolution runs *before* the masker collects, because masking is by value. A variable that is not set fails the run before its first step, in one failure naming every unset variable; the check covers every config object of the whole loaded tree, so a declaration a parent's config shadows still counts. An empty variable is a set one.
- **Secret** — a config value wrapped as `{"$secret": ...}`; secrecy rides the value through shallow-merge inheritance. The engine scrubs every secret value from all persisted artifacts (log events, input/output objects, `context.json`, error strings, stderr, condition **trace** values) at the persistence boundary, replacing it with `[secret:<key>]`. That boundary is the engine's emit of an **observation**: one choke point every observation passes through, rather than a wrapper a caller applies. Workers receive real values — masking is an audit-surface concern, not a dataflow restriction. One surface outside that boundary is scrubbed too, and only one: the error a finished run returns to its caller (`RunResult.error`), which the CLI and the server both print to a terminal that in CI is a retained log. `RunResult.output` is not — it is the product, and an operator is owed the real answer.
