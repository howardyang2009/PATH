# Acceptance workflow: repo release-notes pipeline

Resolves wayfinder ticket #9. This is the concrete LLM/agent pipeline the PATH MVP must run
end-to-end on macOS — the acceptance case every spec decision is tested against.

**The JSON is a sketch.** The format is not final; ticket #10 (Workflow file format v0) owns the
real schema. What *is* binding here is the pipeline itself and the constructs it exercises.

## The pipeline

Given a local git repo and a commit range, produce `RELEASE_NOTES.md`:

1. `gather-changes` (binary, local engine) — `git log --stat` over the range
2. checkpoint `have-changes` — fail fast on an empty range
3. parallel + collect — `summarize-features` ∥ `summarize-fixes` (LLM)
4. `draft-notes` (LLM) — write the draft from the collected summaries
5. `judge-draft` (LLM) → checkpoint `verdict-wellformed` — the judge-step pattern
6. while-do `revise-loop` (max `config.max_revisions`) — nested workflow `revise-cycle`
   (revise → judge → checkpoint), exchanging `{draft, feedback}` / `{draft, verdict}` through
   input/output objects only
7. branch `pick-format` on `verdict.suggested_format` — short vs long formatting (LLM)
8. `write-file` (binary, local engine) — write the final notes to disk

Runs locally with no dependencies beyond git, a shell, and the Agent SDK worker.

## MVP coverage map

| Decision (map #1) | Exercised by |
| --- | --- |
| Step type: runnable binary + config | `gather-changes`, `write-file` |
| Step type: prompt + context | all summarize/draft/judge/revise/format steps |
| Step type: nested workflow (relative path) | `revise` → `./revise-cycle.workflow.json` |
| Logicer: parallel + collect join | `summarize` block |
| Logicer: branch | `pick-format` |
| Logicer: while-do with mandatory max-iterations | `revise-loop` (exceeded → run fails, so post-loop nodes assume a passing draft) |
| Checkpoint = mechanical assertion; judge-step pattern | `judge-draft` + `verdict-wellformed`; also inside `revise-cycle` |
| Condition language (predicate trees) | `matches`, `equals`, `one-of`, `exists`, `valid-json`, `all` over `context.*` paths |
| Config from outside, inherited downward | workflow-level `repo_path`/`commit_range`/`max_revisions`/`output_file` |
| Context as per-workflow-run blackboard | `raw_changes`, summaries, `draft`, `verdict`, `final_notes` |
| Nested-workflow context isolation | `revise-cycle` starts fresh; data crosses only via input/output objects |
| Worker inheritance + override | workflow default = LLM (agent-sdk); binary steps override to local engine |
| Agent SDK worker, parallel fan-out | two concurrent LLM sessions in the parallel block (within the default cap of 4) |

Deliberately absent (deferred by earlier decisions): wait-one / do-not-wait joins, API/MCP/skill
step types, config paths in conditions, templates/inheritance mechanics.

## Questions this sketch raises for #10 / #11

Writing the pipeline down forced several format/semantics needs that the open tickets must settle:

- **Value interpolation** — the sketch leans on `${config.x}` / `${context.x}` placeholders in
  payloads and input mappings. #10 must define the real substitution syntax and where it is allowed
  (notably: `max_iterations` referencing config).
- **Output→context mapping** — steps here use `output.to_context` (single key or key list) to
  publish onto the blackboard. #10 owns the shape; #11 owns when the write happens.
- **Prompt-step context injection** — `context_refs` names which context keys are rendered into the
  LLM input. #10 must decide whether steps declare reads explicitly (as sketched) or see the whole
  context.
- **Branch-arm matching** — already parked in #11; the sketch assumes ordered arms,
  first-match-wins, no-match → run fails.
- **Collect-join output shape** — what the merged output object of a parallel block looks like as
  the next step's input (#11).
- **While-do condition timing** — the sketch assumes check-before-each-iteration against current
  context (a do-while would never run `revise-cycle` when the first draft passes — this pipeline
  needs while-do as sketched) (#11).
- **Binary-step I/O conventions** — how a binary step receives its input object (stdin? env? file?)
  and what its output object is (stdout? exit code always checked?). The sketch hand-waves with
  `stdin_from` (#10/#11).
