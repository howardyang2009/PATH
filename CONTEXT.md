# PATH — Ubiquitous Language

Glossary for the PATH workflow management system. Terms here are canonical; code, specs, and issues use them exactly.

## Core execution model

- **Step** — the unit of work in a workflow. Has exactly one input object and one output object. A step declares *what* to do (its type and payload), not *who* does it.
- **Worker** — *who/where* a step executes: the binding to an execution capability (e.g. local engine, an LLM subagent). Declared per step; inherited from the enclosing workflow when unspecified.
- **Task** — a step bound to a worker. `task = step + worker`.
- **Run** — one executing (or executed) instance of a task. The only execution term in PATH: there is no separate "workflow execution" concept.
- **Processor** — one live instance of a worker that a run executes on (e.g. a local process, a thread, an LLM chat session).
- **Workflow** — a composition of steps. A workflow is itself a valid step type ("workflow-as-step"), so executing a workflow means running the task of the step that wraps it. The top-level workflow is wrapped in an implicit root step. A workflow-step's run spawns **child runs** for its inner steps, forming a **run tree**.

## Composition

- **Logicer** — an engine-evaluated control node that routes and coordinates step execution: collect, wait-one, do-not-wait, branch, while-do. A logicer has no worker, no task, and no run — the engine of the enclosing workflow evaluates it. (Spelled *logicer*.)
- **Checkpoint** — an engine-evaluated assertion node: a fail-fast gate that mechanically tests data or context (format, presence, ranges, exit codes). True → the workflow continues; false → the run stops as failed. A checkpoint has no worker and never exercises judgment — any check requiring judgment (human or LLM) is expressed as a normal step that outputs a verdict, followed by a checkpoint that tests it (the *judge-step pattern*). `assert` vs `if`: branch routes, checkpoint asserts.

## Invariants

1. Only steps execute on workers. Logicers and checkpoints are engine constructs — no worker, no task, no run.
2. Every execution is a run of a task; there is no separate "workflow execution" concept (workflow-as-step).
3. One step has exactly one input object and one output object.
4. Config flows in from outside (author/operator); context is written from inside (steps at runtime).
5. Worker and config are inherited downward from the enclosing workflow unless a step overrides them.

## Relationships

```
Workflow ──composed of──> Steps + Logicers + Checkpoints
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
