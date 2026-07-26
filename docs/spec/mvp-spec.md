# PATH MVP Specification

Resolves wayfinder ticket [#12](https://github.com/howardyang2009/PATH/issues/12) — the destination
artifact of [map #1](https://github.com/howardyang2009/PATH/issues/1). This document assembles every
closed decision of the map into one buildable spec for the PATH MVP: a **local workflow engine
(macOS first) plus the workflow file format, able to run an LLM/agent pipeline end-to-end**.

**How to read this document.** Vocabulary follows [CONTEXT.md](../../CONTEXT.md) exactly — terms
there are canonical. Two decisions already have normative documents in this repo and are
*incorporated by reference*, not restated: the [workflow file format v0](../format/workflow-format-v0.md)
and the [acceptance workflow](../acceptance-workflow/NOTES.md). Everything else — architecture,
execution semantics, worker model, persistence, logging/audit — previously lived only in tracker
resolutions and is stated normatively **here**. Where this document and a tracker comment disagree,
this document wins. §12 maps every section back to its originating decision.

---

## 1. Scope

**In the MVP:**

- A headless workflow engine + CLI (`@path/engine`) and a format schema package (`@path/schema`),
  TypeScript on Node LTS, running on macOS.
- Workflow file format v0 (JSON): three step types (`prompt`, `binary`, `workflow`), three control
  blocks (`parallel` w/ `collect` join, `branch`, `while-do`), `checkpoint` assertions, one
  structured condition language, `${}` interpolation, config inheritance, worker declarations.
- One LLM worker: the Claude Agent SDK (pinned), with subscription-keychain and API-key auth.
- Local persistence under `.path/` (SQLite + blob files), typed log events to db + NDJSON
  backends, secret masking at the persistence boundary.
- Acceptance: the [release-notes pipeline](../acceptance-workflow/NOTES.md) runs end-to-end (§11).

**Out of scope** (ruled out by the map; return only via a redrawn destination):

- Workflow/step template mechanics (`extends`); nested files + config inheritance are the v0 reuse story.
- Online design UI; PATH website/cloud (remote db/storage/log tables).
- Remote engine workers; human/person workers.
- Scheduling, todo-list features, run-path optimization.
- Transactions, chatbot workflow generation, single-file compilation (v2 items).
- Platforms other than macOS (the code is portable Node, but only macOS is exercised).
- Run retry, and resume of crash-interrupted runs — MVP failure behavior is fail-fast only (§5.6).
  Fail-fast is about *failure*: an operator stopping a run is not a failure, and a root run **is**
  cancellable. What a stop owes is truth about where the run got to, not the ability to resume it.

**Deferred with the door held open** — the register of deliberate extension points is §10.

## 2. Domain model

[CONTEXT.md](../../CONTEXT.md) is the canonical glossary (step, worker, task, run, processor,
workflow-as-step, logicer, checkpoint, config vs context, log event, trace, log backend, secret).
The invariants implementers must not break:

1. Only **steps** execute on workers. Logicers and checkpoints are engine constructs — no worker,
   no task, no run.
2. Every execution is a **run of a task**; there is no separate "workflow execution" concept.
   The top-level workflow is wrapped in an implicit root step; a workflow-step's run spawns child
   runs, forming the run tree.
3. One step has exactly **one input object and one output object**.
4. **Config flows in from outside; context is written from inside.** Context is isolated per
   workflow-run; a nested workflow starts with a fresh context and exchanges data with its parent
   only through input/output objects.
5. Worker and config are **inherited downward** from the enclosing workflow unless a step
   overrides them (worker atomically, config key-by-key; worker never crosses a file boundary,
   config does).

## 3. Architecture & stack

- **Language/runtime:** TypeScript (strict) on **Node LTS 22+**. Chosen for the first-class Agent
  SDK and for sharing one schema package with the future TS/React design website. Bun/Deno
  rejected (ecosystem risk for an engine that spawns processes).
- **Repo layout:** pnpm workspace monorepo in this repo:
  - **`@path/schema`** — the format: TypeScript types + zod validation, **no runtime deps**. The
    single source of truth for format v0 (§4) and the condition language; the future website
    imports this same package.
  - **`@path/engine`** — headless engine + CLI, depends on `@path/schema`.
- **Tooling:** vitest for tests, tsx for dev execution.
- **Distribution (MVP):** dev-mode CLI only — run via pnpm/tsx or built JS + node. No npm publish,
  no single-binary packaging, no signing/notarization.
- **Multi-platform stance:** door-open only. Windows/Linux/cloud come free with Node; a future
  mobile/Flutter client talks to an engine over IPC/HTTP. The MVP never bets on sharing engine
  code with mobile, and ships no IPC/HTTP surface.

### CLI surface (minimum decided commands)

- `path run <workflow.json>` — validate the whole file tree, then execute a root run. Operator
  launch-time config values are supplied via CLI flags and/or a config file and override the
  top-level file's config defaults per format §8 (shallow merge, nearest wins).
- `path runs rm <run-id>` / `path runs prune` — delete run db rows and the run directory
  **together** (§6).

`^C` during `path run` **cancels the run** (§5.6) instead of killing the process: the run unwinds
to `cancelled` and the CLI exits **130** (128 + SIGINT), distinct from the failed run's non-zero
exit. Cancellation holds no deadline, so a second `^C` exits immediately without waiting for the
unwind — abandoning it mid-write, with the consequences §5.6 records. Cancellation is a signal,
not a flag.

Exact flag spellings are implementer's choice; the semantics above are not.

## 4. Workflow file format v0

Normative document: [docs/format/workflow-format-v0.md](../format/workflow-format-v0.md).
Summary for orientation only — the format doc wins on any detail:

- Single JSON file, `"format": "path/workflow@0"`, strict zod validation (unknown fields
  rejected), file-unique ids, one flat `type`-discriminated node union.
- Nodes: steps `prompt` / `binary` / `workflow` (relative-path `ref`), controls `parallel`
  (`join: "collect"`) / `branch` / `while-do` (mandatory `max_iterations`) / `checkpoint`.
- `${dot.path}` interpolation with the whole-string typing rule, in allowlisted positions only;
  roots `config`/`context` (+ `output` in `publish` maps).
- Uniform data flow: `input` builds the step's input object (absent = previous node's output);
  `publish` writes step output to context; workflow input seeds child context; top-level `output`
  map is the workflow's output contract; opt-in `parse: "json"`.
- Workers tagged `engine` | `llm` (§7 of the format doc); config = literal values, shallow-merge
  nearest-wins across file boundaries.
- Conditions: zod-validated predicate trees (`exists`, `equals`, `one-of`, `matches`, `range`,
  `valid-json`; `all`/`any`/`not`), roots `context`/`output`, strict error semantics.
- Load-time whole-tree validation: schema, ids, `ref` cycles, `${}` syntax — authoring errors
  surface at load, never mid-run.

## 5. Engine execution semantics

### 5.1 Scheduling baseline

A workflow body executes **strictly sequentially**: the engine walks nodes one at a time, in
order. Concurrency exists only inside `parallel` blocks. No lookahead, no reordering.

### 5.2 Control-node behavior

- **Branch** — arms are evaluated in declaration order; the **first true `when` wins**. `else` is
  optional; no match and no `else` **fails the run** (silent fall-through hides authoring bugs).
- **While-do** — the condition is checked **before every iteration** against current context; zero
  iterations is a normal exit. If the condition is still true after `max_iterations` completed
  iterations, the **run fails** — post-loop nodes may assume the condition resolved to false.
- **Checkpoint** — condition true → continue; false → run stops as failed.
- **Parallel** — structured concurrency: all branches complete before the block does (`collect`);
  no detached runs.

### 5.3 Context write timing

- Sequential flow: a step's `publish` lands **atomically on step success, before the next node
  starts**.
- Parallel flow: each branch executes against a **snapshot of context taken at block entry** —
  siblings never see each other's writes. Branch publishes buffer and land **at the join, applied
  in branch declaration order**. Publish keys are static strings, so duplicate keys across sibling
  branches are rejected at **load time**; no runtime races exist.

### 5.4 Node output objects

- **Step**: its own output (stdout / LLM result / child workflow `output` map), per the format doc.
- **Checkpoint**: transparent — forwards its predecessor's output unchanged (its condition's
  `output` root reads that same object).
- **Branch**: the taken arm's last node's output.
- **While-do**: the last node's output of the final executed iteration; transparent at zero
  iterations.
- **Parallel (collect)**: `{ "<branch-id>": <output object of that branch's last node> }` —
  deterministic regardless of completion order, dot-path addressable.

**Default-input chain** — the mirror rule to the outputs above. When a step omits `input`
(format §6.1), the chain threads *through* blocks: the first node of any block slot — a branch
arm, a parallel branch, a while-do body — defaults to the **block's predecessor's output object**
(parallel siblings all start from that same object, consistent with the context-snapshot rule).
A while-do body additionally chains **across iterations**: iteration 1's first node reads the
block's predecessor's output; iteration N's first node reads iteration N−1's last node's output.
Blocks are thus transparent to one uniform chain, on both their input and output sides.

### 5.5 Processors & the fan-out cap

- Every `prompt` step-run spawns a **fresh SDK session (processor)**, torn down when the step
  completes. No session reuse in MVP: a step reads exactly what its `input` map builds — no hidden
  conversational state. Reuse/pooling is a later opt-in optimization.
- A `binary` step-run is one child process (spawned with the step's `cwd`, stdin/stdout convention
  per format §4.2; non-zero exit fails the step). stderr is not data: it is captured to
  `stderr.txt` in the step-run's directory (§6), secret-scrubbed like every persisted artifact
  (§8.3), and never passed downstream.
- One **engine-wide semaphore** caps concurrent LLM processors: **default 4**, overridable in
  engine config (§7 memory budget) — the `--llm-concurrency` flag or the `llm.concurrency` key of
  the engine-settings file (§6, §9), **not** workflow Config (the cap is one
  engine-wide value, so Config's per-file inherited override would be wrong). It spans the entire
  run tree, including nested workflows and nested parallels; a branch whose next step can't get a
  slot waits. Binary steps are uncapped.

### 5.6 Failure and cancellation

**Fail-fast.** A step failure, a false checkpoint, a condition evaluation error, branch no-match,
or loop-cap exhaustion fails the run. A failing parallel branch **cancels in-flight siblings
best-effort** (processor killed); `cancelled` is a distinct run status from `failed`; no publishes
from cancelled or failed branches land. Rejected for MVP: drain-then-fail, tolerate-failures
(allSettled), per-branch on-failure policy — the latter two would be additive format changes.
Retry and resume are out of scope (§1).

**External abort.** An operator may **cancel a root run in flight** (`RunOptions.signal`). The abort
reaches every descendant run and leaf step of the tree, and the root run ends **`cancelled`** — it
does not die mid-step and it is not left as a lying `running` row. The unit of cancellation is the
**root run only**: one verb, one controller; cancelling a nested run or a single step is out of
scope, since it would need an answer to "does the parent continue?" that collides with fail-fast.
There is no intermediate `cancelling` status — the unwind window is client-local UI state. A signal
already aborted when the run is launched cancels it before its first step. Cancellation is
**best-effort** in both causes: the engine asks, and holds no kill deadline and no force path.
`run-cancelled` names which cause killed a run (`operator` | `sibling-failed`, §8.1).

**The forced exit is the one exception, and it is accepted.** The engine has no force path, but the
CLI's second `^C` (§3) forces the *process*, which abandons the unwind wherever it had got to. The
run's rows keep whatever status they last held — typically `running` for the root and its in-flight
leaves — the terminal `step-finished` is never written, and the backends never close: precisely the
lying `running` row this section says cancellation avoids. That is the price of the escape hatch,
and it is deliberate: an operator forcing an exit has decided that getting their terminal back
outranks a truthful record, and making the force path wait for writes would defeat it. Nothing
reconciles such rows afterwards — resume of interrupted runs is out of scope (§1) — so a forced run
stays `running` in `path runs`, in `GET /v0/runs`, and in any viewer over it, until the operator
removes it with `path runs rm <run-id>` (§3). Cancelling without forcing has none of these
consequences; this applies to the second `^C` alone.

### 5.7 Run records

Run rows exist for **step runs only** (domain invariant 1 — control nodes have no runs). Row
content: run id, parent run id, node id, worker binding, status
(`pending | running | succeeded | failed | cancelled`), timestamps, input/output object refs
(§6), and for LLM runs `usage` (real token counts) + `estimated_cost_usd` (§7). Usage and cost
are recorded **leaf-only** — on the prompt-step runs where tokens were actually spent; no row
stores derived totals. Subtree/whole-run figures are a read-time SUM over descendants (the CLI
may display them), so ground truth exists exactly once and nothing can drift. Control-node
activity is recorded as typed log events (§8), attributed to the enclosing workflow-step's run.

## 6. Persistence

**Hybrid: SQLite for structured records, plain files for blobs — all under a per-project `.path/`
directory** beside the workflow files (like `.git`), gitignored by default.

- **`.path/path.db`** — SQLite via **better-sqlite3** (synchronous API fits the single-process
  engine). Holds structured records only: the **runs table** (§5.7) and the **log table** (§8).
- **`.path/settings.json`** — the **engine-settings file** (§9): a flat JSON object carrying the two
  engine-level operator settings, `log.backends` (§8.2) and `llm.concurrency` (§5.5). Read by the
  engine, never by a step — it is not workflow Config and never merges into `${config.x}`. Absent
  file = built-in defaults; unknown keys and bad values are rejected loudly, like the workflow
  format. An empty `log.backends` list selects no backends — the file spelling of
  `--log-backends none`. Nearest wins: **CLI flag > engine-settings file > built-in default.**
- **`.path/runs/<root-run-id>/`** — one directory tree per **root** run, mirroring the run tree:
  inside it, one subdirectory per run in the tree (keyed by run id) holding that run's blobs —
  `input.json`, `output.json`, for workflow runs `context.json`, and for binary runs
  `stderr.txt`. `run.log` (§8) sits at the
  tree root. Every blob is a **JSON file** referenced by relative path from its run row. No
  size-threshold inlining: one rule, every object cat-able on disk.
- **Context write-through:** every workflow-run has its own isolated context, hence its own
  `context.json` in its run subdirectory; each context mutation atomically rewrites it, so on-disk
  state always matches the live blackboard — mid-run inspection works, crashes leave a truthful
  snapshot, and the door stays open for future resume semantics.
- **Retention: keep everything.** No automatic expiry. `path runs rm <root-run-id>`/`prune`
  operate on root runs, deleting the run tree's db rows and its directory tree together, so the
  two stores never drift and nothing can half-delete.
- **Schema evolution:** stamp the db schema version via `PRAGMA user_version`; on mismatch the
  engine **refuses to open** with a clear message to delete/recreate `path.db` (blob files
  unaffected). No migration framework pre-1.0. This mirrors the format's exact-version rule:
  pre-1.0, nothing migrates, everything fails loudly.

## 7. The LLM worker

- **Implementation: Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), **pinned** — the spike
  ran **0.3.214** (bundled Claude Code binary 2.1.214). One SDK session = one processor, mapping
  1:1 onto the domain model. MCP servers and skills are **worker-side invocation options** (the
  `options` bag of the `llm` worker declaration, format §7), not engine concerns — no engine code
  speaks MCP in MVP.
- **Auth:** the SDK picks up the macOS-keychain subscription OAuth credential when no
  `ANTHROPIC_API_KEY` is set, and the API key when it is. **No headless-CLI fallback mode is
  built.** Caveats (accepted while PATH is a personal local tool): keychain pickup is
  undocumented SDK behavior, and Anthropic policy forbids *offering* claude.ai login in a
  distributed product. The worker contract stays **message-shaped**, so a headless-CLI worker or
  remote runner is a drop-in alternate if either caveat bites.
- **Memory budget:** ~360 MB RSS per live processor, flat under fan-out → budget **~400 MB per
  concurrent LLM processor**; hence the default semaphore cap of 4 (~1.5 GB, comfortable on 16 GB
  machines), config-overridable (§5.5).
- **Cost accounting:** the SDK's `total_cost_usd` is a client-side estimate at API list prices —
  real for API-key users, notional under subscription. Store it as **`estimated_cost_usd`** on the
  run row, alongside `usage` token counts, which are always real.
- **Later, additive:** a lightweight `llm-call` worker type over the direct API (no agentic loop);
  local runtimes as offline fallback. Survey: [llm-worker-execution-options.md](../research/llm-worker-execution-options.md);
  empirics: [agent-sdk-spike-findings.md](../research/agent-sdk-spike-findings.md).

## 8. Logging & audit

### 8.1 Event stream

The log stream is the **full narrative**: step lifecycle events are emitted in addition to run
rows, so the log alone reads as the complete chronological story of a run tree. Run rows remain
the authoritative queryable step record; events are lightweight observations.

**Envelope** (every event): `seq` (monotonic per **root run**, engine-assigned — the ordering
truth; timestamps collide under parallelism), `ts`, `type` (flat discriminated union, one zod
schema), `run_id`, `node_id`. Control events carry the enclosing workflow-step's run id + the
control node's id; lifecycle events carry the step's own run id. There are no workflow start/end
events — workflow-as-step means they are just the workflow step's `step-started`/`step-finished`.

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
| `join-applied` | `branches` (ids in apply order), `published_keys` |
| `run-cancelled` | `cause` (`sibling-failed` / `operator`, §5.6), `cause_run_id` (the failing sibling; null for an operator cancel) |

**Trace** = the condition tree annotated per leaf with its dot-path, outcome
(`true | false | error` + message — strict-semantics evaluation errors surface as `error` leaves,
not a separate event type), and the **actual value read**, post-masking.

**Versioning is per stream, not per event:** the NDJSON file opens with a header line
`{"type": "log-header", "format": "path/log@0", "run_id": ...}`; the db side is covered by
`PRAGMA user_version`.

### 8.2 Backend seam

```ts
interface LogBackend {
  open(run: { runId: string; format: "path/log@0" }): Promise<void>;
  write(event: LogEvent): Promise<void>;
  close(): Promise<void>; // flush; called on run end, success or failure
}
```

- Instantiated **per root run**; all events of the run tree flow through it. NDJSON = one
  `run.log` per root run (nested runs interleave, matching per-root `seq`); the db backend stamps
  rows with the root run id from `open()`.
- **Async signatures, engine-serialized**: one internal write queue per backend, never concurrent
  `write` calls. Local backends resolve synchronously; the async seam exists for future remote
  backends.
- **Backends are dumb sinks**: envelope assembly, `seq`, and masking happen engine-side before the
  seam — a backend can't leak what the engine already redacted.
- **Configuration:** backend list is engine-level operator settings (`log.backends:
  ["db", "ndjson"]`), *not* workflow-file content — the `--log-backends` flag or the
  `log.backends` key of the engine-settings file (§6, §9). **Both on by default.**
- **Failure policy:** any active backend write failure **fails the run** (audit-first: executing
  steps whose events can't be recorded defeats the tool's purpose); the engine still best-effort
  emits terminal events to surviving backends.

### 8.3 Secret masking

- **Marking:** a config value may be wrapped as `{"$secret": "<value>"}`. The wrapper is the
  marking; because config composes by shallow merge per top-level key, secrecy travels with the
  value across every file boundary and operator override. (`$env` sourcing indirection is a later
  additive that would compose with `$secret`.)
- **Redaction: persistence-boundary scrubbing by value.** At run start the engine collects all
  `$secret` values in effective config; everything persisted — log events and traces, input/output
  object files, `context.json` write-throughs, run-row error strings, captured stderr — is
  string-scrubbed before hitting any backend or disk. Required, not hygiene: `${config.token}`
  legally splices into prompts/argv/inputs, so secrets propagate into artifacts; path-based
  redaction leaks.
- **Replacement token:** `[secret:<config-key>]` (same value under two keys → first key wins).
- **Workers receive real values** — masking is an audit-surface concern, not a dataflow
  restriction.
- **Documented limits:** transformed secrets (base64, embedded in emitted JSON) escape string
  matching — accepted, no taint-tracking in MVP. `$secret` values shorter than ~6 chars risk mass
  false-replacement → load-time warning.

## 9. Implementation freedoms

Decided-by-omission: implementers may choose freely, provided the semantics above hold —

- Exact CLI flag spellings and the operator config-file format (§3).
- SQLite DDL (table/column names, indexes) behind the run-row and log-event contracts.
- Run-id format; internal engine module structure; error-message wording.
- The engine-settings file location/format (it must carry `log.backends` and the LLM cap) —
  settled in #27 as `.path/settings.json`, a flat strict-unknown-field JSON object keyed
  `"log.backends"` / `"llm.concurrency"` (§6). Being inside the gitignored `.path/`, it is a
  per-checkout operator setting, not a committed project artifact.

## 10. Deferred register (doors deliberately held open)

| Deferred | Where the door is |
|---|---|
| `wait-one` / `do-not-wait` joins | `join` field stays in the format (`collect` only in v0) |
| API-endpoint step type | curl via `binary` today; promote in v-next |
| MCP/skill step types | live as LLM-worker `options`; revisit only for engine-direct calls |
| Function-in-binary step | v-next shape: in-process JS-module call, not FFI |
| `config` as a condition root | additive third root |
| Input declarations on workflows | additive top-level field |
| Templates / `extends` | strict unknown-field rejection + `@`-versioning keep it additive |
| Session reuse / processor pooling | fresh-processor rule is the contract; pooling is opt-in later |
| `llm-call` worker type; local-runtime workers | message-shaped worker contract |
| `$env` secret sourcing | composes with `$secret` |
| Retry/resume | write-through `context.json` + truthful crash snapshots |
| Remote log backends | async `LogBackend` seam |
| Website/cloud, remote engines, mobile | shared `@path/schema`; IPC/HTTP boundary |

## 11. Acceptance

The MVP is done when the [release-notes pipeline](../acceptance-workflow/NOTES.md)
(`docs/acceptance-workflow/release-notes.workflow.json` + `revise-cycle.workflow.json`) runs
end-to-end on macOS via `path run` with no dependencies beyond git, a shell, and the Agent SDK
worker, and:

1. produces `RELEASE_NOTES.md` for a real commit range;
2. leaves a complete audit trail: run rows for every step run, log narrative in **both** backends
   (db table + `run.log`), every input/output object and `context.json` on disk under
   `.path/runs/<run-id>/`;
3. demonstrates the failure paths: an empty commit range trips the `have-changes` checkpoint; a
   never-passing judge exhausts `max_revisions` and fails the run;
4. respects the LLM fan-out cap and records `usage` + `estimated_cost_usd` on every LLM run.

The pipeline's coverage map (every MVP construct → exercising node) is in the acceptance
workflow's NOTES.md.

## 12. Decision record

| Section | Decision ticket |
|---|---|
| Domain model (§2) | [#2](https://github.com/howardyang2009/PATH/issues/2) → CONTEXT.md |
| Stack & layout (§3) | [#3](https://github.com/howardyang2009/PATH/issues/3) |
| Step-type subset (§1, §4) | [#4](https://github.com/howardyang2009/PATH/issues/4) |
| Logicer subset & block grammar (§4, §5) | [#5](https://github.com/howardyang2009/PATH/issues/5) |
| LLM worker survey (§7) | [#6](https://github.com/howardyang2009/PATH/issues/6) → research doc |
| Condition language (§4) | [#7](https://github.com/howardyang2009/PATH/issues/7) |
| Persistence (§6) | [#8](https://github.com/howardyang2009/PATH/issues/8) |
| Acceptance workflow (§11) | [#9](https://github.com/howardyang2009/PATH/issues/9) → docs/acceptance-workflow/ |
| File format v0 (§4) | [#10](https://github.com/howardyang2009/PATH/issues/10) → format doc |
| Execution semantics (§5) | [#11](https://github.com/howardyang2009/PATH/issues/11) |
| Agent SDK spike (§7) | [#13](https://github.com/howardyang2009/PATH/issues/13) → findings doc |
| Logging & secrets (§8) | [#14](https://github.com/howardyang2009/PATH/issues/14) |
