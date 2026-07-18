# Acceptance workflow: repo release-notes pipeline

Resolves wayfinder ticket #9. This is the concrete LLM/agent pipeline the PATH MVP must run
end-to-end on macOS — the acceptance case every spec decision is tested against.

The JSON files are written in the real **format v0** defined by ticket #10 — see
[docs/format/workflow-format-v0.md](../format/workflow-format-v0.md). Binding here are both the
pipeline itself and, now, the format it is expressed in.

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

## Questions this pipeline raised

The format needs surfaced by the original sketch were settled by #10 (interpolation syntax and
scope, uniform `input` maps, `publish` maps, `parse: "json"`, binary stdin/stdout convention —
see the format doc). Still open, owned by #11 (engine execution semantics):

- **Branch-arm matching** — the pipeline assumes ordered arms, first-match-wins,
  no-match → run fails.
- **Collect-join output shape** — what the merged output object of a parallel block looks like as
  the next step's input.
- **While-do condition timing** — the pipeline needs check-before-each-iteration against current
  context (a do-while would never run `revise-cycle` when the first draft passes).
- **When `publish` writes land** in context relative to parallel siblings.
