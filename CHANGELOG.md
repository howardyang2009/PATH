# Changelog

## v0.4.3 — 2026-08-02

Minor: the first of #109's three deferred doors is shipped, and the second architecture-review pass
that had been sitting merged-but-unreleased on `main` ships with it. `$env` is the feature — a config
value can name an environment variable instead of carrying a literal, and can compose with `$secret`
so the sourced value is both usable and masked. What it earns is narrower than "run non-interactive",
which already worked: a secret becomes **addressable** (`${config.token}` into argv, prompt, input)
and **maskable** (it joins the collected-secret set) without ever sitting in a workflow file, a
`--config` file on disk, or `--set` in shell history.

The format stays `path/workflow@0`. Two things about it change for an author. `$secret`'s value
widens from `string` to `string | {"$env": "NAME"}` — one-way nesting, `$env` inside `$secret` and
never the reverse. And the `$`-sole-key namespace is now **reserved**: any sole-key object whose key
starts with `$` and is not a known wrapper is a load error, where before `{"$evn": "TOKEN"}` passed
silently as literal data and the worker got the wrapper instead of the token. That is the one change
here that can reject a file which loaded in v0.4.2.

Resolution is eager and fails the whole run before step 1, naming **every** missing variable at once
— CI wants one failure listing everything, not step 14 dying several LLM calls in. It runs *before*
secret collection, forced by masking-by-value (§8.3): the masker must collect the resolved token,
never the literal variable name. Ownership went the way #98 set — `@path/schema` owns the shape and
the one depth walk (`wrapper.ts`, `env.ts`, `secret.ts`), each engine reader keeps only its visitor
(`resolve-env.ts`, `secret-mask.ts`).

The audit surface tightened where the acceptance case found it thin: `RunResult.error`, and a
non-succeeded run's `output`, are now masked at the run's return. A succeeded run's output stays
real — it is the pipeline's answer, and handing an operator `[secret:key]` where it belongs would be
the wrong trade. One limit is documented rather than closed: a thrown *bug* escapes masking, because
the engine re-throws rather than swallowing it into a failed run, so its message and stack reach the
CLI's caller and the server's console unscrubbed (§8.3).

Suite 754 → 827 across the release, every existing test passing untouched at each step.

### Features

- feat(schema,engine): `$env` secret sourcing (map #113, built by #114/#115/#116/#117, docs #118) —
  `{"$env": "NAME"}` sources a config value from the environment; `{"$secret": {"$env": "NAME"}}`
  sources *and* marks secret. `mvp-spec` §10's `$env` row is retired, §8.3 carries the shipped rule,
  and format §8.3 is normative for the wrapper and the `$`-sole-key reservation. Masking stays
  by-value deliberately — "env is always secret" was rejected, because an env-sourced model name
  would get its literal string scrubbed out of every log event and input file in the run.

- feat(engine): mask what a finished run hands back (resolves #123, #124) — `path run` printed
  `run failed: ${result.error}` unmasked, so a credential that reached a failed step's stderr reached
  the operator's terminal and, in CI, the retained build log. Under `$env` the operator is frequently
  a secret store rather than a person, which is the exposure `$secret` exists to close. Masked at the
  run's return in `runWorkflow`, where the masker already lives; `@path/server`'s console is closed by
  the same change without `live-runs.ts` touching the masker.

### Fixes

- feat(engine): replay a run's narrative from `log_events` when the NDJSON backend is off
  (resolves #110) — `RunArchive.events()` read `run.log` and nothing else, so a run configured
  `log_backends: ["db"]` — a supported configuration under §8.2, not a degraded one — had no SSE
  replay at all, though every event of it was already in the table. A mid-run subscriber saw only
  what arrived after it connected, and a finished run streamed `[]`. NDJSON stays authoritative
  where it exists, so every replay in the default configuration is byte-identical to before.

### Internal

- refactor(engine): the binary step's process driver is not the run-tree walk (resolves #94) — spawn,
  stdio wiring, exit-code interpretation, SIGTERM on abort and EPIPE tolerance sat inline in the
  module that walks the run tree, while their peer for `prompt` steps had its own module. The cost
  was testability: the driver's sharpest edges — a killed child exits null and that is a cancellation,
  not a non-zero-exit failure (§5.6) — had no test that named them.

- refactor(engine,schema): withdraw the surface each deepening superseded (resolves #96) — `Project`
  owns observer and log-backend assembly, `runWorkflow` owns the run's resources, `openProject` owns
  the archive, and every ingredient of all three was still exported, so a consumer could assemble by
  hand around the owner. Two rules now stated in the index: assembly is not exported, and a seam's
  vocabulary stays even when its default adapter goes private.

- refactor(schema,engine): one owner for what a `$secret` is (resolves #98) — the sole-key rule and
  the any-depth rule were written four times across two packages; `unwrapSecret` and `isSecretWrapper`
  were byte-identical under two names, neither importing the schema that already defined the shape.
  `mapSecrets` is the one walk, and the two engine readers become the line that differs. This is what
  made the `$env` wrapper cheap a release later.

- refactor(engine): the write side of `.path/` is one module, not two (resolves #100) — a `RunStore`
  interface whose five methods were four one-line delegations, and whose seam could not be stated.
  `run-store-writer.ts` is gone; the #72 guarantees survive verbatim with their docblock, and
  `paths.ts` now spells the four blob filenames once instead of `run-archive.ts` keeping a second map
  they could disagree about.

- refactor(engine): the db log backend is one sink that knows its table (resolves #104) — a 28-line
  backend with no implementation without its store, and a 31-line store with no caller but the
  backend. Merged, and `insertLogEvent` is private, which is the point rather than a side effect: the
  sink is the only way a row reaches `log_events`, and the engine assembles the envelope, the `seq`
  and the masking before it.

- test(engine): pin node semantics at the seam, not twice (resolves #102) — #87 shipped `runNode` so
  node semantics were reachable without driving a whole run, but `run-workflow.test.ts` never shrank,
  so branch, loop, join and prompt semantics were pinned in two places. 61 cases there become 35, 24
  at the seam become 40. What is left is what only a whole run has: secret masking, nested trees,
  observer ordering, config inheritance, and the caps that span nested runs.

- test(schema): make a wire field the domain gained a compile error (resolves #107) — a new field on
  `RunRecord` failed to compile at `fromDbRow` but not at `toWireRunRecord`, so a new column could
  reach the db and never reach the API. `keyof WireRunRecord` must now equal the snake-cased
  `keyof RunRecord`; verified by adding a field to each side in turn. `WireRunRecord` stays written
  out by hand — a *derived* wire type would let a domain rename silently rename a field of the v0
  contract (server-api-v0.md §4).

### Docs

- docs(readme): status through v0.4.2 and what's open (#111) — the Status block still named v0.4.0 as
  the latest release and listed the cancellation tickets as the frontier. Now one line per release,
  the two declined review candidates named so the next reader finds them rather than re-deriving
  them, and a What's-next pointing at #109's v-next register.

### Other

- The `$env` map (#113) closed with its parked questions rehomed rather than dropped: unset vs empty
  is decided in §8.3 (`FOO=` counts as set and trips the short-secret warning; only a genuinely unset
  variable fails the run), whether a run *row* should carry its error is in §10's deferred register
  via #124, and whether a run-start failure *reads* well graduates with a viewer to look at it.

## v0.4.2 — 2026-07-28

Patch: six candidates from an architecture review, five built and one refused. v0.4.1 gave the
engine's *interior* the seams it lacked; this pass asks the same question of the parts that already
had owners and finds the things that had none. Each of the five is the same move — something the
codebase already did, done in one place instead of at every call site: reading a run back
(`RunArchive`), running one over HTTP (`LiveRuns`), framing an event on the wire
(`encodeEventFrame`), running one node of a body (`runNode`), and saying what a run's events mean
(`eventOutcome`, `buildRunTree`).

The v0 wire format, every HTTP status and the CLI's surface are unchanged, so the outward-facing
change is confined to what the workspace packages export to each other: `Project.db` is now
`Project.archive`, `@path/engine` no longer exports `getRunsForRoot`, `listRootRuns`, `readJsonBlob`
or `runBlobDir`, `@path/server` no longer exports `RunEventHub`, and `@path/schema` gains the event
stream's frame codec. Every existing test passes untouched at each step, and the suite grows 685 →
754 as the seams become reachable.

The sixth candidate — collapsing the three exhaustive switches over `Observation` behind one
per-variant table — is **not built**, and #91 records why so the next review does not re-derive it.
Investigating it found a real bug instead, which is this release's one fix.

### Fixes

- fix(engine): mask the usage a worker reports (resolves #91)

  `step-usage.usage` is a `JsonValue` supplied by the LLM worker (mvp spec §5.7, §7) and written
  verbatim to the run row. It sat in `maskObservation`'s pass-through group under the comment
  "carry only ids, counts and engine-chosen enum values" — an assumption about what a worker puts
  there, not a guarantee, and it is the one payload crossing that seam the engine neither builds nor
  validates. Token counts are numbers and numbers pass through masking untouched, so scrubbing it
  costs nothing.

  The sweep over all fourteen members asserting no secret survives could not have caught it: the
  `step-usage` sample carried no secret to begin with, so it passed vacuously. **Totality is not
  coverage** — a member can be listed in the switch and still return unmasked. A second test now
  requires every sample to hold the secret before masking, with `CANNOT_CARRY_A_SECRET` naming the
  two members that provably cannot.

### Internal

- refactor(engine): give the read side of `.path/` an owner (resolves #81) — `Project` owned
  assembling a run *into* `.path/` (#64); reading one back and deleting one had no owner, so five
  server routes and two CLI subcommands each composed the same three stores by hand. `Project.db`
  was public purely to let them, which made the engine's on-disk layout part of `@path/server`'s
  contract with nothing in the type system saying the two must move together. `RunArchive` is that
  owner: `rows.find((row) => row.runId === rootRunId)` was written four times, the blob filenames
  lived in an HTTP route, and `path runs rm` carried its own copy of the operator-error policy.

- refactor(server): give the live run one owner (resolves #83) — starting a run over HTTP was never
  one call to `Project.run`: it is a run started, an id answered before the run finishes, a
  controller filed, a live channel opened, and both torn down however the run ends. Five modules
  held a share of it and none of it was reachable without binding a port — `post-runs-registry.test.ts`
  drove a route handler with a hand-built request and response purely to reach a `Map`. Three
  guarantees that were comments a caller upheld are now `LiveRuns`' interface.

- refactor(schema): one event-frame codec, not four (resolves #85) — the framing the log stream
  travels in was written four times, and they had already drifted: one copy accepted `data:` with or
  without the space and the other three sliced a fixed six characters, so a server emitting the
  compact form would have been read by the browser client and silently ignored by everything else,
  including the acceptance harness whose job is to catch that. The same failure `wire-v0.ts` was
  created to end, one layer up.

- refactor(engine): one node seam, not five of seven (resolves #87) — #76 pulled the control-node
  walkers to module scope and stopped, leaving `branch` reachable by a test and `binary` not, though
  a body may hold either in the same position. `runParallelNode` was exported with no direct caller
  anywhere. `runNode` owns everything about one node — which of the seven kinds it is, its config,
  its input, its publish — and the four kinds that had no direct test now have one.

- refactor(client-core): the run's meaning belongs to the core (resolves #89) — a package documented
  as "the core every viewer/designer/mobile surface consumes" could not tell a surface which events
  mean a run stopped, or which run spawned which. Both moved; `eventMessage`, `nodeLabel` and
  `STATUS_GLYPH` stayed, because English copy and glyphs are where a second surface differing is
  correct rather than drift.

### Other

- docs: candidate 6 declined and the reasoning recorded (#91) — the three switches ask three
  different questions, the table would need four field-kind categories plus an escape hatch for
  `step-finished` alone, and locality gets worse: one file per policy becomes one row spanning three
  concerns. The review's premise was also wrong on a fact — `test/fake-observer.ts` is
  compile-checked, not an unguarded fourth copy.

## v0.4.1 — 2026-07-27

Patch: one leak fixed, and the interior given the seams the cancellation phase kept revealing it
lacked. v0.4.0's acceptance run found its bugs by running the whole system, because there was no
smaller thing to run — `run-workflow.ts` had three exports and no internal joints, five recursions
walked the same node tree, and the condition language was implemented once to validate and again to
evaluate. Seven refactors close that gap. The public surface does not move: `runWorkflow`,
`RunOptions`, `RunResult` and the v0 wire format are unchanged, and every existing test passes
untouched at each step — 630, 653, 663, 685 as the suites grew.

Two changes are visible from outside despite the patch number, both consequences of #64, and both
documented in `docs/api/server-api-v0.md`: API-launched runs now honour `.path/settings.json`, which
they never did though the API doc has always described the request fields as "Same as `path run`";
and a malformed settings file now fails server startup rather than being skipped.

`@path/client-core` also stops depending on `@path/engine`. A package documented as "pure-TS,
zero-framework" carried a runtime edge to one shipping better-sqlite3, `node:child_process` and the
Agent SDK, for five `import type`s naming two pieces of domain vocabulary. Its `dependencies` is one
entry now.

### Fixes

- fix(server): close the live channel where the run's controller is dropped (resolves #74)

  Two registries tracked one live run and only one was torn down where the run ends. The controller
  registry was dropped in `post-runs.ts`; the hub channel was opened and closed by the live-forwarding
  backend, off the root run's `run-started`/`run-finished` — nothing the server controls.
  `runWorkflow` drives `run-finished` on every path it controls, so normal and failing runs both close
  cleanly. The gap is the path it explicitly does not control: "any other thrown error is a bug and
  propagates". No terminal event, so `close` never runs, the channel outlives the run, and every
  subscribed SSE client hangs open forever — `res.end()` is wired to the channel's close listener. The
  `.finally()` that already existed to make cleanup true by construction now tears down both.
  Verified against the defect: reverting the two added lines turns both leak tests red.

### Internal

- feat(engine): a Project module owns the run assembly (resolves #64) — running one workflow correctly
  took five modules wired in a required order, and the three callers that did it by hand disagreed.
  Three things stop being *possible* rather than stop being wrong: the directory pair (#59 is no
  longer expressible — no call site supplies both `projectDir` and `workflowDir`), the
  persistence-before-logging observer order, and the settings precedence rule.

- refactor(schema): own the runtime vocabulary, not just the workflow format (resolves #66) — schema
  was the source of truth for what an *author* writes; nothing owned what an *execution* produces, so
  `RunStatus` lived in the SQLite module, `LogEvent` beside the log backends, and the v0 wire record
  was declared five times. The server encoded it and the client decoded it from structurally unrelated
  types in packages with no dependency between them, agreeing only by a prose comment — a renamed
  field type-checked on both sides and broke at runtime in the browser.

- refactor(schema): one condition grammar, not half a module in each package (resolves #68) — the
  `${}` tokenizer existed twice and the engine's copy was correct only because the validator had run
  first, with nothing enforcing that order; an unvalidated string got a silently truncated result
  instead of an error. One tokenizer, one dot-path walk, one operator list, one declaration per root
  set.

- refactor(schema): one walk over the node tree, not five (resolves #70) — four of the five recursions
  ended in `default: break`, so a new block type was silently skipped by id-uniqueness,
  publish-collision and `workflow`-ref scanning rather than rejected. Verified by simulation: adding a
  `wait-one` block type produces **0 compile errors before, 2 after**.

- refactor(engine): a run store of run facts, not an insert-then-update dance (resolves #72) —
  recording one run took four calls in a required order, written out three times. The blob path and
  the row's ref were built separately from the same pieces, one with the host separator and one always
  forward slashes; a mismatch left the bytes on disk and the row pointing elsewhere, with no error and
  no failing test.

- refactor(engine): give the node walk a real interface (resolves #76) — four overlapping context bags
  become two plus a composition of them, and the walkers move to module scope so `runBranchNode`,
  `runWhileDoNode` and the rest can be called directly. `merge-config.ts` (11 lines of object spread)
  had a unit test while the branch, loop and join semantics carrying mvp spec §5.2–5.6 did not; they
  do now.

- refactor(engine): the Observation union, and one required `observe()` (#62) — a partial adapter no
  longer compiles, so masking cannot be applied to some of the seam and not the rest.

### Other

- ci: `pnpm typecheck` and the full test suite run on every pull request to `main`, on Node 22 with
  the pinned pnpm from `packageManager`.
- chore: `main` is protected — PR-only, `test` required green. A tracked `.githooks/pre-commit`
  refuses a commit made on `main`, since one made there could never be pushed anyway.
- docs(context): Observation defined, and Log event as its narrated subset (#62).

## v0.4.0 — 2026-07-26

The **cancellation** phase (`docs/delegation-plan-cancellation.md`): stopping a run in flight from the
CLI, the API and the viewer — the first verb the system offers that changes a run rather than reading
one. A cancelled run ends `cancelled` — a status distinct from `failed`, because an operator stopping
a run is not the workflow breaking — lands no publishes, and is narrated by a `run-cancelled` event
carrying its `cause` (`operator` or `sibling-failed`).

One abort reaches the whole tree: `RunOptions.signal` threads to every descendant run and leaf step,
so the engine kills live child processes and tears down in-flight Agent SDK sessions alike. The unit
of cancellation is the root run only. The surfaces are all thin over that one engine capability —
`^C`, `POST /v0/runs/:root_run_id/cancel`, `cancelRun()`, a button — which is why the acceptance run
(#57) is what counts as evidence rather than any of their unit tests.

### Features

- feat(engine): external abort — cancel a root run in flight (#52)
- feat(engine): graceful `^C` — cancel the run in flight, not the process (resolves #53)
- feat(server): cancel route — `POST /v0/runs/:root_run_id/cancel` (resolves #54)
- feat(client-core): `cancelRun()` — the seam's first write verb (resolves #55)
- feat(viewer): Cancel button — the console's first verb (resolves #56)

### Fixes

- fix(server): resolve a nested workflow ref against the workflow's own directory (resolves #59)

  `POST /v0/runs` passed the server's project directory as `runWorkflow`'s second argument, which is
  not the project directory at all — it is the root workflow file's own directory, and the engine
  resolves nested `workflow` refs and binary `cwd`s against it. The CLI derives its project dir from
  the workflow file, so the two are always equal there and nothing caught the difference until a
  workflow ran through the server from a subdirectory. The test needs a fixture that is *not* at the
  project root; a root-level one cannot fail.

- fix(engine): the `runs` subcommands must reject input they do not understand (resolves #61)

  `runs prune` discarded whatever followed it, so `path runs prune --help` deleted every run in the
  project instead of answering. `path run` has rejected unrecognized arguments all along; the
  destructive verb being the lax one is backwards. `prune` now takes no operands and `rm` exactly one
  (a second id was previously dropped in silence), and `--help` is answered before dispatch so it can
  never be read as an operand.

### Docs

- docs(spec): record what a forced second `^C` costs, and accept it (resolves #60)

  The engine has no force path, but the CLI's second `^C` forces the *process*, abandoning the unwind
  wherever it had got to: rows keep their last status, the terminal `step-finished` is never written,
  the backends never close. That is the lying `running` row §5.6 says cancellation avoids, and
  nothing reconciles it afterwards — resume of interrupted runs is out of scope. Accepted as the
  price of the escape hatch rather than fixed, since making the force path wait for writes would
  defeat it. §5.6 now says so, and the `^C` notice names both the cost and the remedy
  (`path runs rm`) at the moment the operator is deciding whether to press again.

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

