# Changelog

## v0.2.0 — 2026-07-21

The **`@path/server`** map: `@path/engine` becomes reachable over HTTP. A new package exposing a
v0 HTTP + SSE API (4 endpoints) and a `path-server` CLI, an in-process wrapper that adds no engine
capability — the door mvp spec §10 held open for "Website/cloud, remote engines, mobile".

### Features

- feat(server): `@path/server` walking skeleton — boots + `POST /v0/runs` + `GET /v0/runs/:root_run_id` (resolves #35)
- feat(server): `GET /v0/runs` — list root runs (resolves #36)
- feat(server): `GET /v0/runs/:root_run_id/events` — live SSE stream of a run's narrative (resolves #37)
- feat(server): SSE reconnect/replay via `Last-Event-ID` + NDJSON — a dropped client resumes with no gap (resolves #38)
- feat(server): §5 acceptance harness — release-notes pipeline driven end-to-end through the API, all four spec §5 criteria confirmed on a real run (resolves #39)

### Docs

- docs(spec): PATH server API v0 — endpoint contract + assembled spec (resolves #29–#34)

### Other

- refactor(server): dedupe SSE header write in get-run-events
- refactor: derive `RunStatus` from a single `RUN_STATUSES` const
- Dogfood: changelog workflow, run end-to-end on this repo

## v0.1.0 — 2026-07-21

The MVP (map #1): `@path/engine` + `path` CLI runs the release-notes acceptance pipeline
end-to-end on macOS.

### Features

- feat(engine): engine-settings file for log.backends + LLM cap (resolves #27)

### Fixes

_None_

### Other

- docs(acceptance): drop valid-json from the coverage map
- refactor(engine): tighten the acceptance suite on code review
- RALPH: acceptance — release-notes pipeline end-to-end (resolves #26)
- docs(spec): record engine-settings file as follow-up (#27)
- RALPH: LLM worker — Agent SDK prompt steps, fan-out cap, usage/cost (resolves #25)
- Merge sandcastle/issue-23: while-do loops
- test(engine): cover interpolated while-do max_iterations resolution
- RALPH: while-do loops — condition-checked iteration block (resolves #23)
- refactor(engine): clarity cleanups on the parallel-block review
- RALPH: parallel collect join + best-effort cancellation (resolves #24)
- refactor(engine): extract negate helper from nested ternary in condition eval
- RALPH: conditions, checkpoint, branch — control constructs (resolves #21)
- REFINE: swallow stdin EPIPE in runBinaryStep (#20 review)
- RALPH: secret masking at the persistence boundary (resolves #20, mvp spec §8.3)
- PATH add README.md
- refactor(engine): name parseLogBackends result type for cli.ts consistency
- RALPH: logging — typed event stream, LogBackend seam, db + NDJSON backends
- REFINE: drop dead param, align node-handler naming (#22)
- RALPH: Nested workflow steps — workflow-as-step + run tree (resolves #22)
- PATH: submit the fix for sandcastle
- PATH: add sandcastle
- @path/engine: persistence — run records + blobs under .path/
- @path/engine: runtime data flow — ${} interpolation, input/publish, config, parse:json
- @path/engine: walking skeleton — path run executes a sequential binary workflow
- Address code-review findings on @path/schema
- @path/schema: workflow format v0 types + validation, monorepo scaffold
- PATH: add delegation-plan-implementation.md
- MVP spec: coherence-grilling amendments before sign-off
- Add MVP spec: assembly of all map #1 decisions (resolves wayfinder ticket #12)
- PATH: add the delgation plan for specification plan process
- CONTEXT.md: audit vocabulary — log events, traces, backends, secrets (resolves wayfinder ticket #14)
- Add workflow file format v0 spec; acceptance workflow rewritten in v0 (resolves wayfinder ticket #10)
- Add acceptance workflow sketch: repo release-notes pipeline (resolves wayfinder ticket #9)
- Add Agent SDK spike findings (resolves wayfinder ticket #13)
- Add LLM worker execution options survey (resolves wayfinder ticket #6)
- CONTEXT.md: nested block grammar + MVP logicer subset (resolves wayfinder ticket #5)
- Add CONTEXT.md: PATH domain model glossary (resolves wayfinder ticket #2)
- Path: add brainstorm.md

