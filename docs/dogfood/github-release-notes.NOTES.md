# `github-release-notes.workflow.json` — what it cost to build and run

The build-and-run half of [map #129](https://github.com/howardyang2009/PATH/issues/129), which resolves
[#133](https://github.com/howardyang2009/PATH/issues/133). The shape was settled in
[#131](https://github.com/howardyang2009/PATH/issues/131)
([api-door-pipeline-shape.md](../research/api-door-pipeline-shape.md)); the credential in
[#132](https://github.com/howardyang2009/PATH/issues/132). This file is the **record of actually doing
it**: every failed attempt, quoting fix, and confusing error, kept rather than tidied, because
[#134](https://github.com/howardyang2009/PATH/issues/134) reads this as evidence.

**It records no verdict against [the rubric](../research/api-door-rubric.md).** Where an observation
lands on an entry, the entry is named so #134 can find it. To name is not to score.

**Date:** 2026-08-02. **Verified from:** macOS 15 (arm64), `curl 8.7.1`, `node v22.23.1`, against live
`api.github.com`.

**No token value appears in this file.**

---

## 1. What shipped

| File | What it is |
| --- | --- |
| `github-release-notes.workflow.json` | The pipeline. 12 nodes: 7 `binary`, 4 `checkpoint`, 1 `prompt`. |
| `join-issue-refs.js` | Joins the locally-parsed `#N` set to the API listing. Emits `{cited, unresolved}`. |
| `.gitignore` | Covers the two run artifacts (`issues.json`, `release-notes-enriched.md`). |
| `github-release-notes.sample-output.md` | One captured run's notes — the only run artifact a reader can see, since root `.gitignore` carries `.path/`. |
| this file | The wreckage. |

Nothing outside `docs/dogfood/` changed. No engine change, no schema change, no format change, no
dependency, no version bump. `release-notes.workflow.json` and spec §11's offline acceptance set are
untouched.

## 2. The build followed #131 exactly, and #131 was right about the hard parts

The node list, the endpoint, the `--config -` transport, and the `write-out` envelope were all settled
on paper before this ticket started. **They were transcribed, not rediscovered.** Each shell step was
proved standalone before being wired into JSON:

| #131 said | Measured here | Agrees? |
| --- | --- | --- |
| `#N` set from `git log` over `v0.4.1..v0.4.3` is `#81`–`#127` | 24 numbers, `81`–`127` (§9 — the pre-flight check got this wrong) | yes |
| `TZ=UTC … --date=format:'%Y-%m-%dT%H:%M:%SZ' … \| tr -d '\n'` yields 20 bytes, no `+`, no newline | `2026-07-27T07:17:33Z`, 20 bytes | yes |
| The listing returns 57 items, no `Link` | **58** items, no `Link` | drifted by one |
| `%{header_json}` parses; `%header{link}` breaks JSON when a next page exists | both reproduced (§5) | yes |
| `http_code` reaches a checkpoint as a **number** | `401`, `typeof "number"` (§4) | yes |

**The 57-to-58 drift is the interesting one.** The repository gained an issue between #131's measurement
and this run, and the listing is a `since`-anchored window over *current* state, not a snapshot of the
range. Nothing broke; 58 is still under the 100 cap, so `Link` is still absent and the `single-page`
checkpoint still passes. Recorded because it is the mechanism by which this pipeline would one day start
to truncate without any commit to it changing: the guard is the only thing that stands between that and
silently short notes.

## 3. What went wrong: less than expected, and that is itself the finding

#133 was told to keep the wreckage. Honesty requires saying how much there was: **the workflow loaded
clean on the first attempt, ran to its first real checkpoint on the first attempt, and completed end to
end on the first authenticated attempt** (§8). No quoting fight, no interpolation error, no schema
rejection, no round of confusing errors. The one genuine mistake in the whole ticket was in the author's
own pre-flight verification, not in the pipeline, and §9 records it.

That is a weaker result than the ticket anticipated, and it is not because the build was careful. It is
because **#131 spent four live `curl` invocations and a close reading of `binary-worker.ts` in
advance**, and #131 §8 says so. The traps that would have produced the wreckage (`--fail` eating the
body, `-i` breaking `parse: "json"`, `%header{name}` breaking JSON, the `+02:00` silent-wrong-200, the
trailing newline) were all found *there*, on a shell, and are recorded there. #134 should attribute them
to #131 and count this ticket's own contribution as what §4 to §6 below actually add.

The one thing that must not be concluded from a clean first run is that the door is cheap. **Two hours of
prior research is part of the price**, and a reader who did not have #131 in hand would have paid it
here.

## 4. The engine pass, on a deliberately invalid token

Run before the real credential was available, precisely because it costs nothing and exercises
everything except the LLM step:

```
$ GITHUB_TOKEN=<a string that is not a token> npx tsx packages/engine/bin/path.ts run docs/dogfood/github-release-notes.workflow.json
run failed: checkpoint "http-ok" failed: equals "context.meta.http_code" was false
```

Nodes 1 to 5 succeeded, node 6 stopped the run. What that one line proves, all of it new relative to
#131 (which could only reason about it):

- **Interpolation into the multi-line curl-config string works.** This is the first string of its kind
  in the repo: four `${…}` splices across seven config lines, one of them a `$secret`-wrapped value,
  embedded mid-line inside a quoted header. It spliced correctly on the first attempt.
- **`parse: "json"` on a hand-built `write-out` envelope works**, and `http_code` arrives as a real
  number, so `{"type":"equals","value":200}` compares against a number rather than a string. A string
  would have silently never matched.
- **A 401 exits 0 and still publishes.** The step is `succeeded`; the *checkpoint* is what fails the
  run. This is #131 §5's whole construction working as designed.

**One wrinkle worth #134's attention, on rubric `Q2`.** The run's error text is:

```
checkpoint "http-ok" failed: equals "context.meta.http_code" was false
```

It does **not** name the status. An operator who reads only that line knows a check failed, not that the
call was unauthorized. The status is not lost; the narrative event carries it:

```json
{"type":"checkpoint-failed","node_id":"http-ok",
 "trace":{"type":"equals","path":"context.meta.http_code","outcome":"false","value":401}}
```

and `output.json` for `fetch-issues` holds the full envelope. So the information is typed, persisted, and
reachable; it is the top-line failure message that is thin. That is a condition-trace rendering
observation, not an HTTP one: an `equals` against a `grep` count would read exactly as poorly. Per the
rubric's §3 frame rule it points away from a step type.

## 5. `$secret` masking of a credential embedded mid-string — no surprise

#133 flagged this as the run to watch, being the first non-synthetic exercise of the v0.4.3 wrapper, and
specifically whether masking survives a value **embedded inside a larger string** rather than standing
alone as a config value. It does. From the failed run's `fetch-issues` `input.json`:

```
url = "https://api.github.com/repos/howardyang2009/PATH/issues?state=all&since=2026-07-27T07:17:33Z&per_page=100"
header = "Authorization: Bearer [secret:token]"
header = "Accept: application/vnd.github+json"
header = "X-GitHub-Api-Version: 2022-11-28"
silent
output = "issues.json"
write-out = "{\"http_code\":%{http_code},\"headers\":%{header_json}}"
```

A `grep` for the token value across **every** file in the run directory returns nothing. Masking is by
value, so the embedding did not matter, which was the open question, and the answer is that the design
holds.

## 6. `Q5`'s observation, made live

The rubric asks for `ps` against a live run. The pipeline's own `curl` is too short-lived to catch, so
the same construction was held open deliberately (config on stdin, then a `sleep` before EOF):

```
$ ps -ww -o pid=,stat=,args= -p $CURL_PID
13617 SN   curl --config -
```

**`curl --config -` and nothing else.** A sentinel credential passed through the config appears nowhere
in the process table.

One honest caveat about the probe, because a first attempt got this wrong: an initial count of matches
in `ps -eww` returned `2`, which looked like a leak and was not; it was `grep`'s own pipeline text.
Re-run with `grep -v grep`, nothing carries the sentinel. Recorded because the false positive is easy to
reproduce and easy to mis-report, and in this pipeline the config never passes through a shell at all:
the engine writes it to the child's stdin from Node (`binary-worker.ts:106`), so no intermediate process
ever has it in argv.

## 7. The `Q4` probe, quarantined

Run against `per_page=1` on a plain shell, **not through the engine and not against the pipeline's own
config**. #129 requires the workflow be real rather than a probe, so to shrink `per_page` inside it would
have manufactured evidence. Recorded as a note, outside any count, per the rubric §4 `Q4`.

With a next page present, the `Link` value comes back as:

```
["<https://api.github.com/repositories/1303944587/issues?…&page=2>; rel=\"next\""]
```

`%{header_json}` escapes the inner quotes and the envelope parses. The raw `%header{link}` form, on the
identical request:

```
parse FAILED: Expected ',' or '}' after property value in JSON at position 195
```

This is the trap #131 §8 called the only place where a plausible reading of the manual produces a
construction that fails **only** under the condition it exists to detect. Reproduced here independently,
on a live response.

Note what the probe does *not* show: how the pipeline would **accumulate** pages. It does not, by design;
`single-page` fails the run instead. So `Q4`'s actual observation (what accumulation costs) remains
unexercised; only the guard was tested.

## 8. The authenticated run

Ran on the first authenticated attempt, end to end, LLM step included. Total output:

```
$ npx tsx packages/engine/bin/path.ts run docs/dogfood/github-release-notes.workflow.json
{"file":"release-notes-enriched.md"}
```

What the run did, from its own artifacts:

| | |
| --- | --- |
| `http_code` | `200` |
| Items returned | 58, `440654` bytes to `issues.json` |
| `Link` header | absent — `single-page` passed |
| `x-ratelimit-limit` / `-remaining` / `-resource` | `5000` / `4995` / `core` |
| `#N` references extracted | **24** — `81 83 85 87 89 91 94 96 98 100 102 104 107 116 117 118 120 121 122 123 124 125 126 127` |
| Resolved by the listing | **24 cited, 0 unresolved** |
| Of the cited, pull requests | 6 |

`x-ratelimit-limit: 5000` on resource `core` is #132 §4's authenticated figure, so the run demonstrably
used the recorded PAT and not an unauthenticated fallback. Five requests used across the session's probes
and the run itself, against 5000/hour: **no rate limit was approached, let alone hit**, so nothing here
touches #109's retry door.

**The enrichment is real, and checkable.** Every one of the 24 cited numbers appears in the notes,
nothing outside `cited ∪ unresolved` appears in them, and the titles are the API's rather than the
commits'. The clearest single case: the commit subject is `refactor(server): give the live run one owner
(resolves #83)`, and the notes say *"Consolidated the live run's five owners into one (#83)"*, which is
issue #83's own title. That difference is the whole point of the pipeline, and it is only there because
the HTTP call happened.

The `unresolved` path was therefore **not exercised**: the `since` window covered every reference in this
range. `join-issue-refs.js` computes it and the prompt instructs on it, but no live run has yet produced
a non-empty `unresolved` list. Recorded as a gap in the evidence, not a defect.

**`Q3`, for #134:** `x-ratelimit-remaining` was read as `context.meta.headers.x-ratelimit-remaining.0`,
typed, from the same envelope that carries `http_code`, at **zero** extra nodes. The hyphenated segments
resolve through the dot-path grammar exactly as #131 §5.2 predicted, and header values are arrays, hence
the `.0`.

## 9. The one real near-miss, and it was mine

The pre-flight check of the `extract-refs` step, run in a shell before it was wired into JSON, reported
**11** reference numbers. The pipeline's own run of the identical command reported **24**. The pipeline
was right.

The shell check was reading **truncated output**. This session's shell routes `git` through a
token-reducing proxy that elides long output, so `git log --format=%s` came back with subjects cut
mid-sentence, and every `(resolves #94)`, `(resolves #96)`, `(#116, #121)` tail sat exactly in the
elided part. `grep -oE '#[0-9]+'` then faithfully found only the references that survived truncation.

Nothing about the workflow was wrong at any point. What was wrong was the verification, and the shape of
the error is worth stating plainly:

- **It was silent.** Truncated output is still well-formed output. `grep` succeeded, `sort` succeeded,
  the numbers looked plausible, and the count agreed with no prediction that would have contradicted it.
- **It nearly propagated into this file.** An earlier draft of §2 recorded "11 numbers" as *agreeing*
  with #131's `#81`–`#127`, because 11 numbers that span 81 to 127 does agree with a range stated as
  endpoints. The correction came only from a cross-check of the generated notes against the join step's
  output and a find of citations the notes should not have been able to make.
- **It is the same failure mode as `Q1b`'s silent-wrong-200**, one layer out: a request that succeeds
  while it carries the wrong data, invisible to exit codes and checkpoints. Here the wrong data was in
  the *verification* rather than the request.

This is not a rubric observation; no rubric entry covers the author's tooling, and the pipeline never
made the mistake. It is recorded because #133 asked for the wreckage and this is the only genuine
wreckage the ticket produced, and because the lesson generalises past this map: **a verification that
runs through a filtering layer is not a verification of the thing.** The run's own persisted artifacts
under `.path/` were what settled it, which is an argument for the artifacts.

## 10. Two things review raised that were deliberately not fixed

Both come from a review pass over the shipped files, and both are recorded rather than changed. #133's
rule is that a v0 shape which feels wrong is the deliverable, not a thing to quietly correct, and both of
these are shapes #131 §6 settled before this ticket started.

1. **`have-citations` conflates "nothing to cite" with "the join broke."** The checkpoint is `exists
   context.enriched.cited.0.number`, so a commit range that legitimately references no issues fails the
   run rather than produce notes without citations. That is the right behaviour for *this* pipeline
   (enrichment with nothing to enrich is a mistake worth a stop on), but the condition language cannot
   say which of the two it caught. `exists` is the only predicate tolerant of an absent path (#131 §5.3),
   so the guard has no vocabulary for the distinction.
2. **`meta` is a generic name for the publish key** that holds `{http_code, headers}`. `response_meta`
   would read better. Left alone because #131 §6's node table names it `meta`, and a settled shape is not
   re-litigated in the ticket that builds it.

Neither is HTTP-specific, so neither is rubric material as it stands; both are noted here in case #134
wants them.

## 11. Running it

```sh
read -rs GITHUB_TOKEN && export GITHUB_TOKEN     # #132 §3 — never a command line the shell records
npx tsx packages/engine/bin/path.ts run docs/dogfood/github-release-notes.workflow.json
```

From the repo root. `issues.json` and `release-notes-enriched.md` land in `docs/dogfood/`. The default
`cwd` for a `binary` step is the workflow file's own directory (format §4.2), so neither needs a
`work_dir` key nor a `mkdir` node. The run directory is `docs/dogfood/.path/`, which root `.gitignore`
excludes. `github-release-notes.sample-output.md` is the committed copy of one run's notes.

The credential is the zero-permission fine-grained PAT of #132 §2. `gh auth token` would also work and
was **not** used: it carries write scopes across the whole account, and this run is the first live test
of `$secret` masking, so a masking failure would have leaked a far more valuable credential than the job
needs.
