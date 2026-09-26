# Resume door — kill-run observations

What a late kill of the acceptance pipeline actually produced, recorded against the standard frozen in
[#143](https://github.com/howardyang2009/PATH/issues/143) ([resume-door-bar.md](resume-door-bar.md)).
Resolves [#144](https://github.com/howardyang2009/PATH/issues/144). Part of
[map #142](https://github.com/howardyang2009/PATH/issues/142).

**This file draws no conclusion.** It does not say whether the resume door opens, re-parks, or retires.
To apply resume-door-bar.md §5's outcome table to what is recorded here is
[#150](https://github.com/howardyang2009/PATH/issues/150)'s work, the same split
[api-door-observations.md](api-door-observations.md) drew against
[api-door-rubric.md](api-door-rubric.md), kept here on purpose so the same discipline governs both
doors.

**The bar is not edited.** Where a §7 hole condition is met, it is named as a fault in the bar, not
patched here.

**Date:** 2026-08-04. **Measured on:** Darwin 25.5.0 (arm64), `node v22.23.1`, `tsx@4.23.1`, Agent SDK
worker against the pinned model (`claude-sonnet-5`), live: no scripted LLM worker, no mocked cost.

## 0. Method

**Target:** the unmodified `docs/acceptance-workflow/release-notes.workflow.json` plus
`revise-cycle.workflow.json` pair, run via `path run` exactly as `path/workflow@0` and the CLI document
it. Nothing about the pipeline files themselves changed for this ticket.

**Pinned `commit_range`**, so every run below (reference, all three kills, both salvages) reads the
identical 15-commit git history rather than one that drifts with `HEAD` over a multi-hour session:

```
6d54c49057d988fff4804ef809fc4f306b8ba7eb..920b9eed3b85a98d3dfdefc2c81377147d7a2710
```

(this equals the workflow's own default `HEAD~15..HEAD` at the moment this ticket's work began.)

**Landing a kill:** a driver script spawns `path run` (the `tsx` binary directly, see the methodological
note below), tails the project's `run.log` for the run tree it just created, and counts `step-started`
events that match a given `node_id`/`step_type` pair. On the Nth match it delivers `SIGINT` to the
process, once for a clean cancel, twice about 400ms apart for a forced kill, after a 1.5s delay from when
the match is observed. Kill A's target is the first `step-started` for `summarize-features` (inside the
parallel `summarize` block). Kill B and C's target is the **second** `step-started` for `node_id:
"revise", step_type: "prompt"`, the inner prompt step inside `revise-cycle.workflow.json`, which is what
actually executes on each while-do iteration (the outer `workflow`-type step that wraps it is also named
`revise` but carries `step_type: "workflow"`, so the two are unambiguous in the log by type).

**A harness bug, found and fixed before any measurement counted:** the first two automated attempts at
Kill A delivered `SIGINT` to an `npx tsx ...` wrapper process rather than the real CLI process (`npx`
interposes a second process; `child.kill()` from Node only signals the PID it was given). Both attempts
exited with code 130 but left **no cancellation trace at all** (no `run-cancelled` event, no terminal
`step-finished`, rows stuck `running`), which is neither the documented clean shape nor the documented
forced shape. This was a test-harness artifact, not an engine finding: to spawn the `tsx` binary directly
(which `exec`s into the same PID, so `SIGINT` reaches the real process) reproduced the documented
clean-cancel shape immediately, confirmed first by hand (`kill -INT` from a second shell, 3s reaction
delay) before automating it. The two contaminated run rows were removed via `path runs rm` and are not
among the ids below. Recorded here because a reader who reproduces this measurement with their own driver
would hit the same trap.

## 1. Reference run — the denominator

A complete run to success, no kill, same pinned `commit_range`. Root run id
`d40ac0ea-774b-4577-a0a7-f28ff4f01a93`.

| Step | Wall-clock | Tokens (in / cache-write / cache-read / out) | Cost (USD) |
| --- | --- | --- | --- |
| `gather-changes` (binary) | 55ms | — | — |
| `summarize-features` | 18.07s | 2 / 20,858 / 12,578 / 1,063 | 0.1589944 |
| `summarize-fixes` | 32.27s | 2 / 23,049 / 12,578 / 2,304 | 0.1907354 |
| `draft-notes` | 15.63s | 2 / 5,123 / 12,578 / 1,055 | 0.0519294 |
| `judge-draft` | 96.98s | 2 / 21,806 / 12,578 / 8,205 | 0.2724754 |
| `revise` (iter. 1) | 27.28s | 4 / 23,639 / 48,052 / 1,660 | 0.1964566 |
| `judge` (iter. 1) | 42.97s | 4 / 6,748 / 29,514 / 2,829 | 0.0931402 |
| `format-long` | 18.84s | 2 / 4,704 / 12,578 / 1,580 | 0.0570154 |
| `write-file` (binary) | 17ms | — | — |

**Total: $1.0207468, 234.1s wall-clock** (log timestamps; the driver's own measured 234.7s includes
`tsx` process startup). One while-do iteration: the judge failed the first draft and passed the
revision, so this run never exercises a second iteration on its own. Kill B and C below each needed their
own run to reach one.

This is the reference-run-obtained figure resume-door-bar.md §2 calls the denominator. §7's hole
condition ("no complete reference run obtainable") does not fire.

## 2. Kill A — clean cancel inside the parallel `summarize` block

Root run id `7dc7fcc4-839d-466f-aaaf-ccc7f0bb9aeb`. Landed on the first attempt.

**Tree** (`.path/runs/7dc7fcc4.../`): `gather-changes/` has `input.json` plus `output.json` plus
`stderr.txt` (succeeded). `summarize-features/` and `summarize-fixes/` each have only `input.json` (no
`output.json`, no `stderr.txt`), cancelled before either LLM leaf produced a result. The root's own
directory has `input.json` plus `context.json`, no `output.json` (no output contract on a non-succeeded
run).

**Db rows:** root `cancelled`, `gather-changes` `succeeded`, `summarize-features` `cancelled`,
`summarize-fixes` `cancelled`. No lying `running` rows; this is the clean path, and the rows say so
truthfully.

**Log** (trimmed, `trace` omitted): `step-started` times 2 for the parallel branches (seq 5, 6), then
`run-cancelled` (`cause: "operator"`) and `step-finished: cancelled` for each of the two leaves (seq
7–10), then the root's own terminal `step-finished: cancelled` (seq 11). Backends closed; nothing hangs.

**Gross re-burn:** $0. The only run that had succeeded when the kill landed is `gather-changes`, a binary
(engine) step with no LLM cost.

**Salvage:** not attempted; there is nothing to recover. §3's manual-action count is 0, wall-clock 0.

## 3. Kill B — clean cancel inside the second while-do iteration's `revise` prompt

Root run id `ee1f5c5b-5609-4d5b-9739-70b589182961`. Landed on the first attempt: the judge failed both
the initial draft and the first revision, so a second iteration started naturally.

**Tree** (`.path/runs/ee1f5c5b.../`, 22 files, run id and node):

```
a496461f.../input.json, output.json, stderr.txt      gather-changes        succeeded (binary)
ed92812c.../input.json, output.json                  summarize-features    succeeded
e8609c37.../input.json, output.json                  summarize-fixes      succeeded
c1473357.../input.json, output.json                  draft-notes           succeeded
bcef3789.../input.json, output.json                  judge-draft           succeeded
a50ca72f.../context.json, input.json, output.json     revise (iter. 1, nested workflow-run) succeeded
5035c581.../input.json, output.json                  revise (iter. 1)      succeeded
1edeccdb.../input.json, output.json                  judge (iter. 1)       succeeded
c34d2d2b.../context.json, input.json                 revise (iter. 2, nested workflow-run) cancelled — no output.json
09fb3404.../input.json                                revise (iter. 2)      cancelled — no output.json, no stderr.txt
ee1f5c5b.../context.json, input.json                  (root)                cancelled — no output.json
run.log
```

Every succeeded run carries `output.json`; both cancelled runs stop at `input.json` (plus `context.json`
for the two workflow-runs, root included). No partial/truncated files, nothing half-written.

**Db rows**, in order: `gather-changes` succeeded, `summarize-features` succeeded ($0.0506786),
`summarize-fixes` succeeded ($0.0615133), `draft-notes` succeeded ($0.0592094), `judge-draft` succeeded
($0.4836667), the iteration-1 nested workflow-run succeeded, containing `revise` succeeded ($0.1918284)
and `judge` succeeded ($0.0473554). Then the iteration-2 nested workflow-run and its own `revise` prompt
step both show `cancelled`, landed exactly on target, one node deep into the second iteration.

| Step | Tokens (in / cache-write / cache-read / out) | Cost (USD) |
| --- | --- | --- |
| `summarize-features` | 2 / 0 / 33,802 / 1,762 | 0.0506786 |
| `summarize-fixes` | 2 / 0 / 33,801 / 2,484 | 0.0615133 |
| `draft-notes` | 2 / 5,292 / 12,578 / 1,464 | 0.0592094 |
| `judge-draft` | 4 / 37,212 / 47,719 / 15,400 | 0.4836667 |
| `revise` (iter. 1) | 2 / 23,243 / 12,578 / 2,200 | 0.1918284 |
| `judge` (iter. 1) | 2 / 3,764 / 12,578 / 1,341 | 0.0473554 |
| `revise` (iter. 2) — killed, no result | — | — |

**Log:** the same clean shape as Kill A, one level deeper: `run-cancelled`/`step-finished: cancelled` for
the iteration-2 leaf, its parent nested workflow-run, and the root, in that order. Terminal
`step-finished` written at every level; nothing left `running`; both log backends (db, ndjson) closed
cleanly. The process's own exit (code 130, no hang) is the evidence, because a backend left open would
have blocked the event loop from draining.

**Gross re-burn: $0.8942518**, the sum of the six succeeded runs above (everything that ran before the
kill).

### Salvage

**What a run of `revise-cycle.workflow.json` directly, bare, actually does:** nothing useful. A
root-level `path run` has no documented way to seed a file's starting `context`. `runWorkflow` seeds
`context` from `options.input`, and the CLI never populates `options.input` (`cli.ts`'s `RUN_USAGE`
offers only `--config`/`--set`, which land in *config*, not context; see `run-workflow.ts:241`,
`cli.ts:207–268`). `revise-cycle.workflow.json`'s steps read `${context.draft}` / `${context.feedback}` /
`${context.raw_changes}`, which start undefined. "Running a nested workflow file directly" is a
documented affordance (§3), but bare it does not reach the recovery this ticket needed. Worth recording
as its own finding, separate from the result below.

**What was actually done**, using only documented surfaces:

1. Read the killed leaf's own `input.json` (`.path/runs/ee1f5c5b.../c34d2d2b.../input.json`), one blob
   read. Because a step's `input.json` is written when the step *starts*, this file already held the exact
   `{draft, feedback, raw_changes}` the cancelled iteration-2 `revise` prompt was about to run on (47,099
   bytes; `raw_changes` is 43,976 of it).
2. Wrote that content, unedited, into a fresh `--config` JSON file, `path run`'s own documented
   config-loading path (§3, "`path run` with fresh `--config`/`--set`").
3. Authored a small **seed shim** (four nodes, all public `path/workflow@0` mechanics with no internals):
   three `binary` `cat`-passthrough steps that copy `${config.draft}` / `${config.feedback}` /
   `${config.raw_changes}` into context by the documented input-to-stdin-to-stdout-to-`publish` route,
   then a `workflow` step with a relative `ref` to the **unmodified** `revise-cycle.workflow.json` (§3's
   second bullet, exercised for real rather than asserted), fed from that seeded context. No blob was
   edited, no `path.db` was touched, no engine code was patched or instrumented. The shim is exactly as
   "documented" as any workflow an author writes by hand, because it uses nothing the format spec does not
   already describe. It is recorded in full below so the judgment call is checkable rather than asserted.

   ```json
   {
     "format": "path/workflow@0",
     "name": "salvage-revise-cycle",
     "worker": { "type": "llm", "model": "claude-sonnet-5" },
     "config": { "draft": "", "feedback": "", "raw_changes": "" },
     "body": [
       { "type": "binary", "id": "seed-draft", "worker": { "type": "engine" },
         "command": "cat", "args": [], "input": "${config.draft}",
         "publish": { "draft": "${output}" } },
       { "type": "binary", "id": "seed-feedback", "worker": { "type": "engine" },
         "command": "cat", "args": [], "input": "${config.feedback}",
         "publish": { "feedback": "${output}" } },
       { "type": "binary", "id": "seed-raw-changes", "worker": { "type": "engine" },
         "command": "cat", "args": [], "input": "${config.raw_changes}",
         "publish": { "raw_changes": "${output}" } },
       { "type": "workflow", "id": "revise", "ref": "./revise-cycle.workflow.json",
         "input": { "draft": "${context.draft}", "feedback": "${context.feedback}",
                     "raw_changes": "${context.raw_changes}" },
         "publish": { "draft": "${output.draft}", "verdict": "${output.verdict}" } }
     ],
     "output": { "draft": "${context.draft}", "verdict": "${context.verdict}" }
   }
   ```

   (The schema rejects an absolute `ref`: "`ref` must be a relative path, not absolute". So the shim has
   to sit next to `revise-cycle.workflow.json`; it was placed there temporarily and removed immediately
   after the run, never committed.)
4. Ran it: `path run _salvage-revise-cycle.workflow.json --config salvage-b-config.json`.

**Result:** succeeded in **29 seconds**, `verdict.pass: true` on the salvaged draft. New spend to reach
it: $0.0796901 (`revise` $0.0375637 plus `judge` $0.0421264). None of the $0.8942518 already spent was
repeated.

**Manual actions: 4** (read one blob, write one config file, author one reusable shim, run one command).
**Wall-clock: 29s** plus the time to write the shim once (reused unmodified for Kill C).

**Residual (B): $0.8942518 − $0.8942518 = $0.**

## 4. Kill C — forced (second `^C`) at the same node as B

Root run id `ce510dc0-f7db-4c96-a926-931aec6d182a`. Landed on the first attempt.

**Tree** (`.path/runs/ce510dc0.../`, 22 files, run id and node):

```
af748bbc.../input.json, output.json, stderr.txt      gather-changes        succeeded (binary)
0436b434.../input.json, output.json                  summarize-features    succeeded
f01d26d1.../input.json, output.json                  summarize-fixes      succeeded
5bc99a68.../input.json, output.json                  draft-notes           succeeded
f219c04d.../input.json, output.json                  judge-draft           succeeded
e7aad9d8.../context.json, input.json, output.json     revise (iter. 1, nested workflow-run) succeeded
7a023874.../input.json, output.json                  revise (iter. 1)      succeeded
a97e263e.../input.json, output.json                  judge (iter. 1)       succeeded
74d52bfa.../context.json, input.json                 revise (iter. 2, nested workflow-run) running — no output.json
b7c9d336.../input.json                                revise (iter. 2)      running — no output.json, no stderr.txt
ce510dc0.../context.json, input.json                  (root)                running — no output.json
run.log
```

Same shape as Kill B's tree through the succeeded prefix. The difference is entirely in the last three
rows' **db status**, not in which files exist on disk. `b7c9d336.../input.json` (the killed leaf's input)
is present, complete, and identical in kind to Kill B's `09fb3404.../input.json`. A forced kill does not
truncate or omit the one blob the salvage below depends on.

**Db rows:** the same six-run prefix as Kill B, all `succeeded` (`gather-changes`, `summarize-features`
$0.0518838, `summarize-fixes` $0.1923394, `draft-notes` $0.0528884, `judge-draft` $0.2933064,
iteration-1 `revise` $0.2246512, iteration-1 `judge` $0.0988454), then the root row **and** the
iteration-2 nested workflow-run row **and** its `revise` prompt row all read `status: running`, with no
`finished_at`. They will read `running` forever; nothing reconciles them (resume-door-bar.md §1, §5.6's
admitted hole).

| Step | Tokens (in / cache-write / cache-read / out) | Cost (USD) |
| --- | --- | --- |
| `summarize-features` | 2 / 0 / 33,436 / 1,849 | 0.0518838 |
| `summarize-fixes` | 2 / 21,723 / 12,578 / 2,941 | 0.1923394 |
| `draft-notes` | 2 / 4,799 / 12,578 / 1,244 | 0.0528884 |
| `judge-draft` | 2 / 22,524 / 12,578 / 9,290 | 0.2933064 |
| `revise` (iter. 1) | 4 / 24,800 / 48,334 / 3,056 | 0.2246512 |
| `judge` (iter. 1) | 2 / 4,895 / 12,578 / 4,266 | 0.0988454 |
| `revise` (iter. 2) — killed, no result | — | — |

**Log:** stops cold at `seq 25` (`step-started` for the iteration-2 `revise` prompt) with no `seq 26`.
No `run-cancelled`, no terminal `step-finished` at any level, matching exactly what the pre-existing
example artifact (`6de6dc12-...`, mentioned in #144) showed: "the log stops at seq 6 with two
`step-started` and no terminal events." This run reproduces that shape on a fresh kill rather than a
reliance on the pre-existing artifact.

**stderr:** only `"cancelling… (Ctrl-C again to force — leaves the run's rows running; clear with path
runs rm)"`, the first `^C`'s message. No `"run cancelled"`: the second `^C` calls `forceExit(130)` before
the unwind the first `^C` started can finish or report anything.

**Backends:** unlike Kill A/B, the process exits via `forceExit` (`process.exit(130)` called directly,
not a drained event loop), so a still-open db/ndjson write is genuinely possible rather than ruled out by
the process having exited cleanly. Nothing in the log or db shows a torn/partial write (`run.log`'s last
line is complete valid JSON, and the three `running` rows are otherwise well-formed), but "did it close"
cannot be answered as confidently here as it was for A/B's graceful exit. Recorded as an open point
rather than asserted either way.

**Gross re-burn: $0.9139146**, the sum of the six succeeded runs (higher than Kill B's because this
independent run's judge produced longer/more expensive outputs; the two kills are different LLM draws,
not the same run replayed).

### Salvage

Identical method to Kill B, same reusable shim: read the killed leaf's `input.json` (still present and
complete; it is written at step start, so a forced kill has no more effect on this one blob than a clean
one does), fresh `--config`, run the shim.

**Result:** succeeded in **79 seconds**, `verdict.pass: true`. New spend: $0.3022607 (`revise`
$0.2372443 plus `judge` $0.0650164). Again, none of the $0.9139146 already spent was repeated.

**Manual actions: 4** (same shim reused; only the recovered blob and the `--config` file are new).
**Wall-clock: 79s.**

**Residual (C): $0.9139146 − $0.9139146 = $0.**

**Residual ÷ total run spend (C, the bar's judged kill): $0 ÷ $1.0207468 = 0%.** This is the fraction
resume-door-bar.md §2 defines the bar around ("stating the bar as a fraction is what makes it
scale-invariant"), recorded here as that fraction, nothing more. To look this figure up against §5's
outcome table and name an outcome (open / re-park / retire) is explicitly
[#150](https://github.com/howardyang2009/PATH/issues/150)'s step, not taken here.

## 5. Recorded, not weighed (resume-door-bar.md §6)

- **Wall-clock re-burn.** To reach the kill point cost 287.3s (B) and about 262.3s (C) of real wall time.
  The salvage that recovered each one's spend cost 29s and 79s respectively, both far under the about 234s
  the full reference run took, and both far under what a from-scratch rerun would cost in time as well as
  money.
- **Clean-vs-forced delta (B vs. C).** The dollar and token shape is not comparable (different LLM
  draws), but the *mechanism* delta is exactly what resume-door-bar.md §5.6 predicts: B's unwind took
  about 3.6s from the second-iteration `step-started` to the root's `finished_at` and left every row
  truthful; C's forced exit left three rows that read `running` with no `finished_at` at all, forever.
  The salvage procedure itself did not need to touch or wait on either; it started an independent new run
  from a recovered blob, so B's clean unwind bought the salvage nothing that C's abandoned one cost it.
- **The lying `running` rows (Kill C).** Three rows (root, the iteration-2 nested workflow-run, its
  `revise` prompt) will report `running` until `path runs rm` is run against them by hand. Per
  resume-door-bar.md §1 this is a finding this door does not own: a reconcile pass that marks abandoned
  rows crashed at next startup would close it with no resume semantics at all. Recorded here, not weighed.
- **The seed-shim gap.** "Running a nested workflow file directly" (§3) is a real documented affordance,
  but bare it recovers nothing, because no documented CLI path seeds a root run's `context`. The shim in
  §3 above closes that gap using only public format v0 mechanics (no internals), but it is a construction
  this ticket had to build, not a built-in one-liner. Whether that distinction matters to how
  "recoverable" resume-door-bar.md §3 should be read is left to #150.
- **Nothing else surfaced** that belongs to another door (retention, the fresh-processor contract, the
  server's view of an interrupted run). The acceptance pipeline ran locally through the CLI alone, never
  through `@path/server`.

## 6. Hole check (resume-door-bar.md §7)

None of resume-door-bar.md §2's quantities were unmeasurable. The reference run completed, and
`estimatedCostUsd` was populated on every LLM leaf across all five runs (reference, A, B, C, both
salvages) with no gaps. Both kills landed on the named node on the first attempt; no retries were needed,
so no question of "shopping for a depth" arises. The one open question is not a measurement hole but the
methodological one flagged in §5 above (the seed shim's standing under §3), which is recorded rather than
resolved here.

## 7. Run ids, for reproduction

All `.path/` contents are gitignored (`docs/acceptance-workflow/.path/.gitignore` is `*`) and exist only
on the machine this was run on, same as the two pre-existing example artifacts #144 mentions. Recorded
here so a reader with access to that machine can re-inspect the raw trees. Nothing below is required to
trust the numbers above, which are quoted in full.

| Run | Root run id |
| --- | --- |
| Reference (denominator) | `d40ac0ea-774b-4577-a0a7-f28ff4f01a93` |
| Kill A | `7dc7fcc4-839d-466f-aaaf-ccc7f0bb9aeb` |
| Kill B | `ee1f5c5b-5609-4d5b-9739-70b589182961` |
| Kill B salvage | `2c8fd8ce-8950-4941-b19d-2ec9e90d7fa1` |
| Kill C | `ce510dc0-f7db-4c96-a926-931aec6d182a` |
| Kill C salvage | `63298f09-1d3f-4b16-8fd3-8dd45ce00173` |
