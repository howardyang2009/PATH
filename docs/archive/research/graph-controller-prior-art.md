# Graph Controllers — jump & human-routing prior art in workflow engines

**Issue:** [#547](https://github.com/howardyang2009/PATH/issues/547) — gather prior art on how established workflow / orchestration engines model the two moves PATH's Graph Controllers introduce. Part of map [#544](https://github.com/howardyang2009/PATH/issues/544) (person-switch [#477] & goto [#478]).
**Date:** 2026-09-21.
**Method:** primary sources only — official engine docs and specs. Each claim is cited to the doc that owns it. Secondary write-ups are used only to locate a primary claim, never as the claim's source.

---

## Why this survey exists

PATH executes a strict recursive `for...of` walk (`runSequence`, `packages/engine/src/run-workflow.ts`): single-entry / single-exit blocks, output threaded node-to-node, **every node runs exactly once**, no program counter. The two Graph Controllers break that:

- **`goto`** — an arbitrary first-level jump, backward edges (cycles) included.
- **`person-switch`** — a human at runtime picks the next branch.

Both introduce **graph edges the tree cannot express**. The three questions this survey asks every engine, because they are exactly where PATH's tree model (ADR 0006/0007 GUID identity, ADR 0037 while-do per-iteration scope, ADR 0039/0041 appendable-tree Complete) will be stressed:

- **Q1 — run identity under cycles:** when a node is visited more than once, how does the engine keep the two visits distinct in its run identity / history?
- **Q2 — non-termination:** what bounds an unbounded loop?
- **Q3 — tree-log vs graph edges:** the execution record is (or wants to be) a tree; how does it cope with an edge that points sideways or backward?

The pattern across every engine below: **a graph is authored, but the *record* is a linear, append-only, per-iteration-keyed log — never a tree with back-edges.** That is the single most load-bearing finding for #544.

---

# Move (a): arbitrary jumps / gotos between top-level steps

## BPMN 2.0 — sequence flows + link events

**The jump.** BPMN's execution graph is `SequenceFlow` edges between flow nodes; the graph is arbitrary and may contain cycles (loops are just back-pointing sequence flows). For readability BPMN adds **link intermediate events** as an explicit off-page "go-to": a *throwing link event* is the exit, a *catching link event* the re-entry, and "They are linked together by their link name. Multiple throwing link events can link to the same catching link event" ([Camunda — Link events](https://docs.camunda.io/docs/components/modeler/bpmn/link-events/)). Operationally "two paired link events function the same as two intermediate none events connected via a sequence flow" — a goto with no drawn line.

**Scope limit (directly relevant to PATH's "first-level jump").** Link events "can only be used to link sections of a process within the same scope. I.e., they can only exist together on the root process level or within the same subprocess" (ibid.). BPMN's own goto is deliberately **flat / same-level**, matching #478's "first-level" framing — you cannot link from inside a subprocess out to the root.

- **Q1 (cycles):** BPMN execution is **token** semantics — a token flows along sequence flows; a loop sends the token back through the same node again. Identity attaches to the *token / process instance*, not to a per-visit node id; each pass is simply "the token is here again." There is no notion of a node instance being unique-per-visit at the model level.
- **Q2 (non-termination):** nothing in BPMN bounds a loop. Termination rests entirely on the gateway condition the modeler supplies; a token "circles in loops based on the loop condition, and when the condition becomes false, execution continues" ([Camunda BPMN reference](https://camunda.com/bpmn/reference/)). No engine-level iteration cap — the guard is the only guarantee.
- **Q3 (tree-log):** BPMN does not keep a tree. The runtime record is a token trail / audit log of node-enter / node-leave events over the graph. Back-edges are native because the record was never a tree.

## AWS Step Functions — `Next` / `Choice`

**The jump.** Every non-terminal state names its successor with `Next`; a `Choice` state branches by evaluating an ordered array of **Choice Rules**, transitioning "to the state specified in the `Next` field of the first Choice Rule in which the variable matches" ([AWS — Choice state](https://docs.aws.amazon.com/step-functions/latest/dg/amazon-states-language-choice-state.html)). `Next` may name **any** state including an earlier one, so a backward edge is just a `Next` pointing up — this is the canonical Step Functions loop (a counter incremented in a Task/Pass, tested by a `Choice`, back-edge to the loop body).

- **Q1 (cycles):** the state machine definition is reused every pass; distinctness lives only in the **execution event history**, which is a flat, ordered, numbered event list (each state entry/exit is a new event), not a tree and not a per-node identity. Two visits to the same state = two separate history events.
- **Q2 (non-termination):** bounded by a **hard quota of 25,000 events per Standard execution**; on overflow the execution fails with "The execution reached the maximum number of history events (25000)" ([AWS — history limit best practice](https://docs.aws.amazon.com/step-functions/latest/dg/bp-history-limit.html)). AWS's prescribed escape for genuinely long loops is to **give each iteration its own history**: Distributed Map (each iteration a child execution) or nested `StartExecution` (a new state machine execution from a Task). The loop guard itself is the modeler's `Choice` counter; the 25,000 ceiling is the backstop.
- **Q3 (tree-log):** flat event history. Loops don't threaten a tree because there is no tree; the "escape from a growing linear log" is spawning **child executions**, each with a fresh, separate history — the same move Temporal and Conductor make.

## Temporal — code loops + Event History + Continue-As-New

**The jump.** Temporal has no state-graph DSL; control flow is ordinary code, so a `goto`/backward edge is just a `for`/`while` loop. The constraint is durability: the workflow is replayed from its **Event History**, "an append-only log of events" / "a sequence of Events" ([Temporal — Event History](https://docs.temporal.io/workflow-execution/event)).

- **Q1 (cycles):** each loop iteration appends **new** events to the linear history (new, sequential event ids); the same code path visited twice produces two distinct runs of events. Determinism on replay is what keeps repeated visits coherent — not a node identity scheme.
- **Q2 (non-termination):** hard bounds on the history — the Service "logs a warning after 10,240 Events" and **terminates the execution when history exceeds 51,200 Events, 2,000 Updates, or 10,000 Signals** (ibid.). The sanctioned escape is **Continue-As-New**: it "closes the current Workflow Execution and creates a new one" with the same type and id, resetting the history counters so an effectively infinite loop runs as a chain of bounded executions.
- **Q3 (tree-log):** linear append-only history per execution; Continue-As-New chains executions rather than nesting a tree. Again: **the record is a linear log, and the bound is achieved by starting a fresh log, not by pruning a tree.**

## XState — statechart transitions

**The jump.** A transition "is a change from one finite state to another, triggered by an event" ([Stately — Transitions](https://stately.ai/docs/transitions)); a transition `target` may be any sibling/ancestor/descendant state, so backward edges and loops are native. Self-transitions are first-class, with three kinds — **targetless** (children preserved, no entry/exit re-run), **targeted** (children reset to initial), and **re-entering** (`reenter: true`, entry/exit re-run) (ibid.). Guards gate a transition ("if its guard passes").

- **Q1 (cycles):** XState is **memoryless** — the machine holds only the *current* finite state (plus context), so revisiting a state carries no per-visit identity and keeps no growing per-visit log. Distinctness between visits is not represented at all unless the author stores it in `context`. Its **history states** (shallow/deep) are the *opposite* concern: they let a compound state resume the child it was last in, i.e. deliberately collapsing "which visit" into a single remembered target.
- **Q2 (non-termination):** none at the engine level — a statechart is a reactive machine with no run history to overflow; an infinite event loop is a modeling concern, not an engine bound.
- **Q3 (tree-log):** XState has **no execution log to reconcile.** The "tree" in XState is the *statechart's* state hierarchy (compound/parallel states), not a record of visits. This is the cleanest illustration that graph routing and a persistent tree-log are orthogonal: XState gets graph edges precisely by *not* keeping a per-visit tree.

## Netflix Conductor — FORK/JOIN + DO_WHILE

**The jump.** Conductor is JSON-defined with operators: `FORK_JOIN` / `FORK_JOIN_DYNAMIC` fan out parallel branches, `JOIN` barriers them, `SWITCH` (formerly `DECISION`) branches, and `DO_WHILE` is the loop. Conductor forbids arbitrary back-edges; iteration is contained inside `DO_WHILE` rather than expressed as a free goto.

- **Q1 (cycles) — the standout mechanism for PATH.** Conductor makes repeated visits **identity-distinct by name-mangling**: when a `DO_WHILE` schedules its body, "each task of this loop will see its `taskReferenceName` concatenated with `__i`, with `i` being the iteration number, starting at 1"; per-iteration outputs are indexed by iteration and referenced as e.g. `$.LoopTask['iteration']['first_task']` ([Conductor — Do-While](https://conductor.netflix.com/reference-docs/do-while-task.html); [Orkes — Do While](https://orkes.io/content/reference-docs/operators/do-while)). So the *same* authored node becomes `ref__1`, `ref__2`, … at runtime — a synthetic per-visit id layered over a stable design-time ref. Directly analogous to what #544 needs if PATH keeps stable GUIDs (ADR 0006/0007) but must distinguish a re-visited node under `goto`.
- **Q2 (non-termination):** the `loopCondition` expression is the guard; it is evaluated each pass and the loop ends when it is false. (Bound is the authored condition; Conductor adds no implicit iteration cap in the model, though the iteration-indexed output map grows per pass.)
- **Q3 (tree-log):** a workflow execution is a **flat list of task executions**; the `__i` suffix is exactly how a non-tree, non-unique authored graph is projected into a flat log where every entry is unique. The loop's iteration-indexed output map is the reconciliation surface, not a tree with back-edges.

---

# Move (b): human-selected runtime routing

## BPMN + Camunda — user task feeds an exclusive gateway

The canonical pattern: a **user task** captures a human decision into a process variable, and a downstream **exclusive (XOR) gateway** routes on it. The gateway "selects one outgoing sequence flow based on data such as process variables"; the engine "evaluates `conditionExpression` values in BPMN XML order and takes the first sequence flow whose condition is fulfilled," else the **default flow** ([Camunda — Exclusive gateways](https://docs.camunda.io/docs/components/modeler/bpmn/exclusive-gateways/)). If no condition matches and there is no default flow, an **incident** is raised and the instance halts — a deliberate fail-stop rather than a silent stall.

**Key design point for `person-switch`:** the human choice is **not** a direct edge selection — it is *data* (a variable) written by the user task, and routing is a *pure function of that data* at the gateway. The human never names the target node; they set a value, and a declarative condition maps value → branch. This cleanly separates "who decides" (user task, cf. #488 assignee) from "what the decision means" (gateway condition) and keeps the routing decision **replayable/auditable from the recorded variable**.

- **Q1/Q3:** the human choice lands as a variable write in the process instance's audit log (a token/event record), so a re-visit under a loop just writes the variable again with a new timestamp; no tree.
- **Q2:** same as move (a) — the guard/condition is the only bound.

## Temporal — Signals / Updates drive branch choice

Temporal routes on human input via **messages into a running workflow**: **Signals** are asynchronous fire-and-forget; **Updates** are synchronous (the client "will call into the corresponding Update handler" and can wait for `Accepted` or `Completed`) ([Temporal — Sending messages](https://docs.temporal.io/sending-messages)). A handler "receive[s] the message data and can modify workflow state or make decisions that branch execution logic — effectively allowing the client to influence which path the workflow takes next" (ibid.). A human client sends the Signal/Update; the workflow's own code branches on the received value.

- **Q1/Q3:** each Signal/Update is a discrete event **appended to the linear Event History** (`WorkflowExecutionSignaled` and update events), so the human decision is durably ordered in the same append-only log — the routing input is itself a replayable history event, not a tree edge.
- **Q2:** the message counts feed the same history bounds as move (a) — **≤ 2,000 Updates and ≤ 10,000 Signals per execution** before termination ([Temporal — Event History](https://docs.temporal.io/workflow-execution/event)); a workflow that takes unbounded human decisions must Continue-As-New. So even *human routing* is capped by the linear-log ceiling and escapes via a fresh execution.

---

## Cross-engine synthesis (the three questions, side by side)

| Engine | Backward jump primitive | Q1: repeated-visit identity | Q2: non-termination bound | Q3: log shape |
|---|---|---|---|---|
| BPMN / Camunda | sequence flow back-edge; link events (same-scope goto) | token, not per-visit id | modeler's gateway condition only | token trail / event log |
| Step Functions | `Next` (incl. upward) + `Choice` counter | flat numbered event history | **hard 25,000 events**; escape = child executions (Distributed Map / nested) | flat event list |
| Temporal | code `while`/`for` | new events per iteration; replay determinism | **51,200 events / 2,000 updates / 10,000 signals**; escape = Continue-As-New | linear append-only history |
| XState | transition `target` (any state); self-transitions | memoryless — no per-visit record | none (reactive machine) | no execution log; only statechart hierarchy |
| Conductor | `DO_WHILE` (no free goto) | **`taskRef__i` per-iteration name-mangling** | authored `loopCondition` | flat task list, iteration-indexed outputs |

## Load-bearing takeaways for map #544

1. **No engine keeps a tree with back-edges.** Every durable engine (SFN, Temporal, Conductor) records a **flat, append-only, ordered log**; the graph lives in the *definition*, the log stays linear. PATH's tree-structured run/resume/audit model (ADR 0039/0041) is the outlier a `goto` must be reconciled against — prior art says reconcile by **projecting graph visits into a linear/keyed log**, not by adding back-edges to the tree.
2. **Cycles are handled by per-visit keys, not by mutating node identity.** Conductor's `taskRef__i` is the concrete pattern: keep the stable design-time id (PATH's GUID, ADR 0006/0007) and derive a **synthetic per-iteration instance key** for the record — the same shape PATH's while-do per-iteration run scope (ADR 0037) already uses. `goto` cycles most naturally reuse that iteration-scope mechanism rather than inventing node re-identification.
3. **Non-termination is bounded two ways, and PATH must pick:** (a) an **authored guard** (BPMN gateway, Conductor `loopCondition`, SFN `Choice` counter) — necessary but not sufficient; and (b) an **engine backstop** (SFN 25k, Temporal 51.2k) whose escape hatch is *always* "start a fresh bounded execution" (Continue-As-New / child executions). A PATH `goto` almost certainly needs both: a required loop-guard on the goto node **and** an iteration/history cap.
4. **Human routing = data + declarative condition, not direct edge selection.** BPMN/Camunda's strong pattern is: the human writes a *variable* (user task), a *pure condition* maps it to a branch (exclusive gateway), and the choice is replayable from the recorded variable. Temporal's Signal/Update is the same idea as an ordered history event. For `person-switch`, prefer recording the **selection as an audited value** (a `switch-selected` event, cf. #544's proposed audit events) that a pure router consumes, over letting a human imperatively name a jump target — this preserves Complete/replay correctness (ADR 0039/0041).
5. **BPMN's own goto is deliberately same-level** (link events cannot cross scope), which independently validates #478's "first-level jump only" scoping instinct.

---

*Sources are linked inline above; all are first-party engine documentation or the BPMN reference. Where a search surfaced a claim, the claim is cited to the owning doc (AWS, Temporal, Camunda, Conductor/Orkes, Stately), not to the search.*
