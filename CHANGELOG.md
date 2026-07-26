# Changelog

## Unreleased

The **cancellation** phase (`docs/delegation-plan-cancellation.md`): stopping a run in flight from the
CLI, the API and the viewer. A cancelled run ends `cancelled` — a status distinct from `failed`,
because an operator stopping a run is not the workflow breaking — lands no publishes, and is narrated
by a `run-cancelled` event carrying its `cause`.

### Features

- feat(engine): external abort — cancel a root run in flight (#52)
- feat(engine): graceful `^C` — cancel the run in flight, not the process (resolves #53)
- feat(server): cancel route — `POST /v0/runs/:root_run_id/cancel` (resolves #54)
- feat(client-core): `cancelRun()` — the seam's first write verb (resolves #55)
- feat(viewer): Cancel button — the console's first verb (resolves #56)

### Other

- refactor(engine): fold a leaf step's cancellation tail into one helper
- refactor(server): the cancel route must not read terminality off a non-root row
- refactor(server): keep the controller registry out of the public API (#54)
- test(client-core): `waitFor` a condition, not a microtask count (resolves #58) — `settle()` drained a
  fixed ten microtasks, which was not a timeout but an assertion about how many `await`s deep the
  production promise chain ran, vetoing refactors in files the test does not name.

- **Acceptance: the release-notes pipeline cancelled mid-fan-out, through the API and under the CLI**
  (#57). Agent SDK worker, real spend. Both live `prompt` processors took the abort: each got its own
  `run-cancelled` with `cause: "operator"` and `cause_run_id: null`, a `cancelled` `step-finished`, and
  a root terminal `step-finished` with the backends closed. `context.json` held only `raw_changes` —
  neither cancelled step's publish landed. Under the CLI, one `^C` unwound in 2.6s and exited **130**;
  a second `^C` during the unwind exited in 0.02s. The viewer's pill read cancelled, both narrative
  lines read "cancelled by the operator" with no phantom sibling run id, and a reload replayed the
  terminal state from the NDJSON.

  What the pass turned up, which is the part worth writing down:

  - **The first attempt never cancelled anything.** The pipeline died at `revise-loop` on
    `referenced file "./revise-cycle.workflow.json" is not in the loaded tree`, and the operator's
    click hit an already-`failed` run. `POST /v0/runs` passes the server's project root where
    `runWorkflow` expects the workflow file's own directory, so no server-run workflow outside the
    project root can resolve a nested ref. Filed as **#59**; the CLI derives the directory correctly,
    which is why this survived to acceptance.
  - **A forced second `^C` leaves a lying `running` row** — root and both leaf runs frozen, no terminal
    events, backends never closed. That is the exact state `mvp-spec.md:191` says cancellation exists
    to prevent, reintroduced by the escape hatch, and nothing reconciles it afterwards. Filed as
    **#60**.
  - **The fan-out window is about five seconds wide**, so the cancel had to be fired by a poll loop
    rather than a human click — `gather-changes` is a local `git log`, and both summarize prompts
    return fast. The trigger was the same `POST /v0/runs/:root/cancel` the button calls, so the code
    path under test is unchanged, but no operator will hit this window by hand. Two live processors is
    also the ceiling this pipeline offers, not an arbitrary "several".
  - **The old-log replay proves less than the ticket assumed.** The one persisted v0.3-era log in the
    repo carries zero `run-cancelled` lines, so replaying it cannot exercise `cause`'s default. It
    replays clean through `readNdjsonLog` — 16 events, no schema error — and that is all it shows. The
    default itself rests on `packages/engine/test/logging/log-event.test.ts:53`.
  - The root run carries no `run-cancelled` of its own, only its `cancelled` `step-finished`. By
    design: `logging-observer.ts:113` scopes the event to the cancelled *step* run, and the root is a
    workflow-run. Recorded so it does not read as a gap later.

## v0.3.1 — 2026-07-25

Patch: the node-I/O pane could hide an output object that exists. Found by running the LLM-backed
release-notes acceptance pipeline through `path-server` and watching it in the viewer — the pass
v0.3.0 shipped without.

### Fixes

- fix(viewer): show a finished run's output when its ref arrived after the last tree read (resolves #51)

  v0.3.0 decided blob absence from the run record's `input_ref`/`output_ref` rather than from a 404,
  since the route 404s for an unknown root, a run outside the tree and a missing file alike. But refs
  only enter the snapshot through a tree read, and the tree is re-read only when the stream discovers
  an *unknown* run — never because a known one finished. Nothing follows the last node of a tree, so
  its refs never arrived: the pane claimed "no output object yet" about a finished step, and Refresh
  could not help, because a null ref skipped the request entirely. Absence is now decided by whichever
  source cannot lie: a **running** run with no ref is still not asked, a **terminal** one is asked
  regardless and its 404 is trusted.

### Other

- Acceptance: the **release-notes pipeline** (Agent SDK worker, `v0.2.0..v0.3.0`) driven end-to-end
  through the API and watched in the viewer — parallel LLM fan-out with a collect join, the
  judge-step pattern, a `while-do` that exited on a passing verdict, a branch, and a real
  `RELEASE_NOTES.md` on disk. Retires the deviation recorded against map #40; the nested
  `revise-cycle` workflow stayed unexercised, the judge having passed the draft first time.

## v0.3.0 — 2026-07-25

The **MVP viewer** map (#40): a read-only web monitor for a live `path-server`. Two new packages —
`@path/client-core`, the pure-TS core every future surface consumes (typed API client, SSE client
with `Last-Event-ID` resume, run view-model; zero framework imports), and `@path/viewer`, a React
web view over it. Four read verbs, no more: **list, open, watch, inspect**. `@path/server` grew the
two things the map allowed — static serving for the built bundle, and a blob route so a browser can
read a run's input/output objects it cannot reach on the server's filesystem.

### Features

- feat(client-core): pure-TS core — API client + SSE with `Last-Event-ID` replay + run view-model (resolves #41)
- feat(server): static file serving + SPA fallback — one process, one origin, no CORS (resolves #42)
- feat(server): `GET /v0/runs/:root_run_id/blobs/:run_id/:name` — a run's input/output object, already masked (resolves #43)
- feat(viewer): scaffold the React app shell — Vite + dev proxy + core wiring (resolves #45)
- feat(viewer): runs-list surface + the three-pane console frame (resolves #46)
- feat(viewer): run-detail surface — root-run status + live indented run tree (resolves #47)
- feat(viewer): live-narrative surface — `seq`-ordered SSE event stream + stream liveness (resolves #48)
- feat(viewer): node-I/O surface — a run's masked input/output objects as mono JSON, with their blob refs (resolves #49)

### Fixes

- fix(viewer): re-read the runs list, which never refreshed after mount — a finished run kept reading as running while the live centre pane disagreed (resolves #50)
- fix(viewer): run-row legibility against real run ids and the dark theme
- fix(server): await child exit before `rmSync` in the bin e2e teardown

### Docs

- docs(api): document the blob route as server-api-v0 §4.1, closing the "no blob-serving endpoint in v0" gap
- prototype(viewer): layout + design-token exploration — pinned Variant A (three-pane console) and the token set (#44)

### Other

- refactor(viewer): share the loading and failure notes across the read surfaces
- refactor(viewer): apply code-review fixes to the runs-list surface
- refactor(client-core): drop dead `readFrames` return, dedupe the default fetch
- refactor(server): use `path.extname` in the serve-static content-type lookup
- Dogfood: all five map-#40 criteria walked in a browser against a live `path-server` — list, open,
  live tree + narrative, mid-run reload replaying with no gap, and node I/O (including a running
  node picking its output up unprompted when the run finished). Driven by the local `changelog`
  workflow and a purpose-built `slow-demo`, **not** the LLM-backed release-notes pipeline.

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

