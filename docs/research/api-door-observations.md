# API-endpoint door — observations against the rubric

What the build and run in [#133](https://github.com/howardyang2009/PATH/issues/133) actually produced,
recorded entry by entry against the standard fixed in
[#130](https://github.com/howardyang2009/PATH/issues/130)
([api-door-rubric.md](api-door-rubric.md)). Resolves
[#134](https://github.com/howardyang2009/PATH/issues/134). Part of
[map #129](https://github.com/howardyang2009/PATH/issues/129).

**This file draws no conclusion.** It does not say whether the door opens, does not apply the
weighing rule in rubric §3, and does not tally the entries. That is
[#135](https://github.com/howardyang2009/PATH/issues/135)'s work, and it is deliberately not done
here. Where a §3 rule's *factual* precondition is met — the `Q2`/`Q3` collapse, the `Q4` quarantine —
the fact is stated and the rule is left unapplied.

**The rubric is not edited.** Its preamble requires corrections to land here as verdicts, not as
edits there — *"a rubric the person who felt the pain can edit is not a rubric"*. One entry (`Q6`)
records `unobservable`; §2.7 says why.

**Date:** 2026-08-02. **Measured on:** Darwin 25.5.0 (arm64), `curl 8.7.1` (libcurl/8.7.1,
nghttp2/1.68.1), `node v22.23.1`, against live `api.github.com`.

**No token value appears in this file.** The probes below use the sentinel
`ghp_SENTINEL134NOTAREALTOKEN`, which is not a credential, or no credential at all.

### Provenance of the freeze

The rubric was committed in `351094e` and the workflow in `5c73a6f`, in that order, so the claim that
the standard predates the JSON is checkable from `git log` rather than asserted:

```
5c73a6f feat(dogfood): the GitHub enrichment workflow, built in format v0 and run live (#133) (#139)
351094e docs(rubric): pre-register the API-endpoint door rubric, before any workflow JSON (#130) (#136)
```

### Where the observations come from

Three sources, distinguished throughout because they carry different weight:

1. **The persisted run artifacts** under `docs/dogfood/.path/runs/` — two runs of this workflow:
   `7f549c03…` (the `401`, `2026-08-02T11:06`) and `2f9f60df…` (the successful run,
   `2026-08-02T11:10`). Primary evidence.
2. **The build record** in [`github-release-notes.NOTES.md`](../dogfood/github-release-notes.NOTES.md)
   and the design record in [`api-door-pipeline-shape.md`](api-door-pipeline-shape.md). Secondary —
   used for what happened, not for how it scores. Where this file's count disagrees with theirs, the
   disagreement is stated rather than smoothed (`Q2`).
3. **Probes re-run for this ticket**, listed with their commands so any of them can be repeated.
   Written because #134 asks for the concrete artifact — the `ps` output, the exit code a 404
   produced — and several of those were asserted in #133 rather than shown.

---

## 1. Verdicts at a glance

| Entry | Weight | Verdict | The one-line reason |
| --- | --- | --- | --- |
| `Q1a` shell quoting | contributory | **`fine`** | The HTTP node is the one binary node with **no shell in its path**. The `sh -c` cost is general to `binary` and v0 already pays it. |
| `Q1b` URL and query construction | contributory | **`pain`** | Hand-encoding was required, and a mistake in it returns `200` with a different window — demonstrated live, and the shipped mitigation is itself wrong by two hours. |
| `Q2` non-2xx as a shell exit code | contributory | **`pain`** | Two extra nodes — `read-body` and `http-ok` — exactly the 2 the rubric pre-registered as its prediction. The one-node form was not found. |
| `Q3` response metadata as data | contributory | **`pain`** (same construction as `Q2`) | Bar defers to `Q2`'s count. `parse: "json"` survives and headers arrive typed; the node cost is `Q2`'s. |
| `Q4` pagination | contributory | **`not-exercised`** | 58 items, no `Link`. The honest-exercise rule forbids counting it either way. The `per_page=1` probe is quarantined. |
| `Q5` token in argv | **decisive** | **`fine`** | `curl --config -` keeps the credential out of argv. Verified live against `ps`, with the `-H` counterfactual measured alongside. |
| `Q6` locatability | contributory | **`unobservable`** | The rubric makes the observer's freshness part of the measurement and requires a **human** who did not write the file. No conforming observer existed. §2.7 records what a non-conforming reading found. |

Two entries came back clean (`Q1a`, `Q5`), and one of those is the decisive one. §2.1 and §2.6 give
them the same space as the rest, because a clean entry is the evidence that keeps a door shut and it
is the entry a write-up thins out.

**Facts §3 keys on, stated without being applied:** a single construction — `output = <file>` plus a
`write-out` envelope — resolves both `Q2` and `Q3`, so §3's collapse condition is met on the facts.
Exactly one entry is `unobservable`, so §3's hole rule (two or more) is not met on the facts. The
`Q4` probe is a note outside the count.

---

## 2. Entry by entry

### 2.1 `Q1a` — shell quoting through `sh -c` → **`fine`**

**Bar:** `pain` only if the difficulty is specific to the HTTP call — something that would not have
arisen writing the same value into a `grep` or `cat` step.

**Observation.** The HTTP node does not use a shell at all. Of the workflow's seven `binary` nodes,
three go through `sh -c`, and the `curl` node is not one of them:

| node | command | shell? | why the shell, where there is one |
| --- | --- | --- | --- |
| `gather-subjects` | `git` | no | — |
| `extract-refs` | `sh` | **yes** | pipeline: `grep … \| tr … \| sort` |
| `since-date` | `sh` | **yes** | pipeline plus `TZ=` prefix |
| **`fetch-issues`** | **`curl`** | **no** | `args: ["--config", "-"]` |
| `read-body` | `cat` | no | — |
| `join-refs` | `node` | no | — |
| `write-file` | `sh` | **yes** | redirect: `cat > "…"` |

Every `sh -c` in this workflow is there for a pipe, a redirect, or an environment prefix — the three
things `spawn(command, args, { cwd })` (`packages/engine/src/binary-worker.ts:55`) does not do. None
is there because of HTTP. This is precisely the comparison rubric `Q1a` demanded, and it comes out
against pain: the request is the *one* place in the file where the author did not reach for a shell.

**The one HTTP-specific escaping cost, measured and recorded anyway.** The `write-out` envelope is a
JSON template inside a curl-config string inside a JSON file, which produces the only depth-3
escaping in the repository:

```json
"write-out = \"{\\\"http_code\\\":%{http_code},\\\"headers\\\":%{header_json}}\"\n"
```

Counted across every workflow file in `docs/`:

| file | `\\\"` (depth 3) | `\"` (depth 2) |
| --- | --- | --- |
| `docs/dogfood/github-release-notes.workflow.json` | **4** | 20 |
| `docs/acceptance-workflow/release-notes.workflow.json` | 0 | 12 |
| `docs/acceptance-workflow/revise-cycle.workflow.json` | 0 | 10 |
| `docs/dogfood/changelog.workflow.json` | 0 | 2 |
| `docs/acceptance-workflow/env-secret-probe.workflow.json` | 0 | 0 |

So the HTTP node did introduce an escaping depth no other node in the repo needs. It is recorded
because it is real and HTTP-specific. It does not meet the bar: the construction was **expressible**,
it was **correct on the first attempt** (NOTES §3, §4), and it does not produce a wrong request when
mis-written — a broken `write-out` breaks `parse: "json"` loudly, which is the opposite of `Q1b`'s
silent failure. Per #130's own framing of what makes quoting a cost — inexpressible, unreadable, or
silently wrong — this lands only on "arguably less readable", which the rubric declined to score.

Verdict `fine`, with the note the bar asks for: **the quoting cost here is general to `binary`, not
to HTTP.**

### 2.2 `Q1b` — URL and query construction → **`pain`**

**Bar:** `pain` if hand-encoding was required **and** a plausible mistake in it is invisible at run
time. `fine` if encoding was mechanical, or if a mistake fails loudly.

**First, what was not built.** The rubric names `?q=repo:owner/name+is:issue+closed:>=DATE` as the
observation. That string was never built: #131 §3 rejected `/search/issues` for the listing endpoint.
The entry is **not** `unobservable` on that account — the `?q=` grammar is the rubric's illustration,
and the bar is written generally about hand-encoding and invisible mistakes. The window value
`since=` supplied a live instance of exactly that. The narrowing is recorded: the `?q=` grammar has
more to mis-encode than `since=` does, so this entry was exercised **more softly than #130
envisaged**, and it still resolved `pain`.

**Hand-encoding was required.** The URL is assembled by string splicing, with no encoding step
anywhere:

```json
"url = \"${config.api_base}/repos/${config.repo}/issues?state=all&since=${context.since_date}&per_page=100\""
```

`${context.since_date}` is whatever the previous node printed. Nothing between that node and the wire
percent-encodes it. Keeping the request correct is entirely the author's obligation, discharged by
constructing a value that happens to need no encoding.

**A mistake in it is invisible — demonstrated, not asserted.** The plausible mistake is `git log
--format=%cI`, the obvious way to get an ISO-8601 commit date, which emits an offset:

```
raw %cI : 2026-07-27T07:17:33+02:00
```

An unencoded `+` in a query value is decoded by the server as a space. Four requests, same endpoint,
differing only in the `since` value (`q1b-probe.sh`, unauthenticated, public repo):

| | `since` sent | `http_code` | items |
| --- | --- | --- | --- |
| A | `2026-07-27T07:17:33Z` (what the pipeline sends) | `200` | 59 |
| B | `2026-07-27T07:17:33+02:00` (the mistake, spliced raw) | `200` | 59 |
| C | `2026-07-27T07:17:33%2B02:00` (the same instant, encoded) | `200` | **60** |
| D | `2026-07-27T07:17:33%2002:00` (a space — what B becomes) | `200` | 59 |

**B and D agree, and both differ from C.** That is the mechanism caught in the act: the `+` really is
being decoded as a space, the server discards the mangled tail, and the author who wrote `%cI`
intending C's window silently receives A's. Every row is `200`. No exit code, no checkpoint, no test
in this repository can tell these four apart — the difference is one issue in the result set.

**And the shipped mitigation is itself wrong, by two hours.** #131 §7 identified the `+02:00` hazard
and mitigated it with `TZ=UTC` and a `Z`-suffixed format. The mitigation does not work:

```
$ git log -1 --format=%ct v0.4.1                                              # 1785129453
true UTC instant                                                              2026-07-27T05:17:33Z

$ TZ=UTC git log -1 --date=format:'%Y-%m-%dT%H:%M:%SZ' --format=%cd v0.4.1     # the workflow
2026-07-27T07:17:33Z

$ TZ=UTC git log -1 --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format=%cd v0.4.1
2026-07-27T05:17:33Z
```

`--date=format:` renders in the **commit's own** timezone and ignores `TZ`; only `format-local:` (or
`iso-strict-local`) converts. The `Z` in the format string is a **literal character**, not a
conversion — it asserts UTC without making it UTC. So the pipeline's `since` is two hours later than
the commit it is derived from, and the window silently excludes anything updated in those two hours.
Live consequence, both windows fetched today:

```
correct window (05:17:33Z): 60 items
shipped window (07:17:33Z): 59 items
dropped by the 2h error: [80]
  #80  updated_at=2026-07-27T05:18:58Z  docs(changelog): v0.4.1
```

The #133 run's *output* was nonetheless correct, because no commit in `v0.4.1..v0.4.3` references
`#80` — the range's references start at `#81`. **The pipeline is right by luck, not by construction.**

Both clauses of the bar are met, and the second is met twice over: hand-encoding was required, a
plausible mistake in it is invisible at run time, and the map's own participants made a
silent-window mistake while writing the code whose purpose was to avoid one. Verdict `pain`.

**A caveat #135 needs, and it cuts against the door.** The timezone defect is *not* answered by this
entry's counterfactual capability. "A query expressed as structured pairs and encoded for the author"
would have faithfully encoded a wrong timestamp and produced the same silently-wrong `200`. Only the
`+02:00` half of this entry's evidence is answered by the counterfactual. The timezone half is
recorded again in §3.2 as unanticipated, flagged for rubric §3's frame rule.

### 2.3 `Q2` — a non-2xx arriving as a shell exit code → **`pain`**

**Bar:** counting every node that exists only to recover the status — `fine` at one extra node,
`pain` at two or more, or if the construction breaks `parse: "json"`.

**`parse: "json"` did not break.** The envelope parses and the status arrives correctly typed. From
the successful run's `fetch-issues` `output.json`
(`docs/dogfood/.path/runs/2f9f60df…/13f8e215…/output.json`): `http_code` is `200` as a JSON **number**,
so `{"type":"equals","value":200}` compares against a number. A string would have silently never
matched. Confirmed on the failing path too — `7f549c03…`'s narrative event carries
`"value":401` in the condition trace.

**The exit code a 404 produces, measured.** #131 reasoned about this path and #133 only ever saw a
`401`, so it was re-run directly:

```
$ curl --config - < cfg404.txt          # url=…/definitely-not-a-real-repo-134, output=file, write-out envelope
{"http_code":404}
exit=0
$ head -c 60 body404.json
{ "message": "Not Found", "documentation_url": …, "status": "404" }
```

**Exit 0 on a 404, body intact, status typed in the envelope.** This is the construction working: the
step succeeds and the checkpoint is what stops the run. It is also the whole problem — a bare `curl`
reports nothing to the engine, so the status has to be smuggled out as data.

**The node count, which is where this entry turns.** Rubric §4 pre-registered its prediction: *"the
expected answer is 2 nodes — one to separate the status from the body (`-w`/`%{json}` contaminates
the output object; `-D file` needs a reader), one checkpoint. If #133 finds a one-node form, that is
a genuine update and scores `fine`."*

Counting the shipped workflow against the counterfactual where the status is not needed:

| | nodes |
| --- | --- |
| Status not needed | `curl --config -` writes the body to stdout, `parse: "json"`, publish. **1 node.** |
| Status needed (shipped) | `fetch-issues` (`output = issues.json` diverts the body so the envelope can own stdout) → `read-body` (`cat issues.json`, `parse: "json"`) → `http-ok` (checkpoint). **3 nodes.** |

**Two extra nodes: `read-body` and `http-ok`.** `read-body` exists for exactly the reason the
rubric's parenthetical anticipated — separating status from body costs a reader — merely inverted:
the body goes to the file and the envelope keeps stdout, rather than `-D file` and a header reader.
The cost is identical either way, and there is no arrangement of `-w`, `-D` and `output =` that
avoids it, because one of the two streams always ends up in a file that something must read back.
The checkpoint counts because the rubric's own prediction counted it.

The pre-registered prediction of **2** was correct. The one-node form was not found, so the update
clause does not fire, and the bar puts two or more at `pain`.

**The strongest argument against this verdict, recorded rather than left out.** A one-node form is
*available* for this particular pipeline: `join-issue-refs.js` is already a custom script immediately
downstream, and it could read `issues.json` off disk itself, deleting `read-body` and leaving only
`http-ok`. That needs no engine change. Three things weigh against it, and #135 should rule on them
rather than take this file's word:

- It was **not built**. The rubric's update clause is conditional on #133 *finding* a one-node form,
  and #133 shipped the two-node one.
- It is available **only because a custom script happened to be the next step**. A pipeline whose
  next consumer is `grep`, `cat`, or a `prompt` node still needs the reader, so the saving is a
  property of this workflow rather than of `curl`-through-`binary`.
- It buys the node back by **giving up `parse: "json"`** on the body and moving an undeclared file
  read inside a script — the target moves out of the workflow file, which is `Q6`'s concern.

**This contradicts #131 §8 and #133's NOTES, and the disagreement is the point.** #131's pre-run
table recorded `Q2` as *"answered on paper — one extra node"*, and NOTES §8 recorded `Q3` at *"zero
extra nodes"*. Both counts omit `read-body`. `read-body` is in the shipped file, and it is there
solely because the envelope took stdout. The rubric was frozen before either document existed
specifically so that a builder's count of their own construction would not be the count that scored
it.

### 2.4 `Q3` — response metadata reachable as data → **`pain`** (one construction with `Q2`)

**Bar:** same node count as `Q2` — `fine` at one extra node, `pain` at two or more, or if
`parse: "json"` breaks.

**Everything the entry asked to read was readable, typed, and clean.** `x-ratelimit-remaining` and
`x-ratelimit-reset` are in the same envelope as the status. From the successful run's `fetch-issues`
`output.json`, 26 headers captured:

| header | value |
| --- | --- |
| `x-ratelimit-limit` | `["5000"]` |
| `x-ratelimit-remaining` | `["4995"]` |
| `x-ratelimit-reset` | `["1785671493"]` |
| `x-ratelimit-resource` | `["core"]` |
| `x-ratelimit-used` | `["5"]` |
| `link` | **absent** |

Reachable as `context.meta.headers.x-ratelimit-remaining.0` — hyphenated segments resolve through the
dot-path grammar, and header values are arrays, hence the `.0`. `parse: "json"` survives.
`x-ratelimit-limit: 5000` on resource `core` also confirms the run was authenticated with #132's PAT
rather than falling back to an anonymous request.

**Why this records `pain` despite reading cleanly.** The bar does not measure whether the headers
were readable — they were, easily. It measures node count, and it defers that count to `Q2`:
"same node count as `Q2`". `Q2`'s count is 2. Recorded `pain` on that basis.

**The sensitivity, stated so #135 can rule on it rather than inherit it.** Had headers been the
*only* requirement, with no status check, the construction would cost **one** extra node
(`read-body`, no checkpoint) and would score `fine` standing alone. The entry is `pain` because it
travels with `Q2`, not on its own merits. Under §3's collapse rule these are one finding counted
once, so the distinction may not change anything — but it is #135's to decide, and the alternative
reading is recorded rather than suppressed.

**No rate limit was hit.** Five requests against 5000/hour across the whole session. Recorded as a
note only; per rubric §4 and #129, retry and rate-limit handling are #109's separate door.

### 2.5 `Q4` — pagination against the one-output-object rule → **`not-exercised`**

**Honest-exercise rule:** pagination is observed only if the real commit range at a sensible
`per_page` naturally spans pages.

It does not. The `v0.4.1..v0.4.3` window returned **58 items** at `per_page=100`, no `Link` header,
and the `single-page` checkpoint passed. The verdict is `not-exercised`, and rubric §4 forbids #135
from counting it in either direction.

**The count drifts, and that is worth recording.** Three measurements of the same nominal window:

| when | items |
| --- | --- |
| #131, on paper | 57 |
| #133, the live run | 58 |
| today, re-measured for this file | 59 (60 at the correctly-derived `since`) |

The listing is a `since`-anchored window over *current* state, not a snapshot of the range, so it
grows as the repository does. Nothing broke — 59 is still under the 100 cap. It is recorded because
it is the mechanism by which this pipeline would one day start truncating with no commit to it
changing, and the `single-page` checkpoint is the only thing standing between that and silently short
notes.

**The `per_page=1` probe, quarantined.** Run on a plain shell, not through the engine and not against
the pipeline's own config, per rubric §4. With a next page present the `Link` value comes back as
`["<https://…&page=2>; rel=\"next\""]`; `%{header_json}` escapes the inner quotes and the envelope
parses, while the raw `%header{link}` form on an identical request fails with
`Expected ',' or '}' after property value in JSON at position 195`. This is a note, explicitly outside
the count.

**What the probe does not show, and nothing in this map does:** how the pipeline would **accumulate**
pages. It never accumulates — `single-page` fails the run instead. `Q4`'s actual observation, what
cross-iteration accumulation costs against `publish`'s interpolated-value shape, remains unmade.
Only the guard was tested.

### 2.6 `Q5` — the token in argv → **`fine`** (decisive entry)

**Bar:** `pain` **iff** no usable non-argv transport exists within `curl`-through-`binary` as v0
stands. If one exists and #133 used it, `fine`.

One exists and #133 used it. `curl --config -` reads its options from stdin; the engine writes the
step's input to the child's stdin from Node (`binary-worker.ts:106`), so the config never passes
through a shell and no intermediate process ever holds it. Re-verified live for this ticket with a
sentinel, and with the counterfactual measured in the same script so the comparison is like-for-like
(`argv-probe.sh`; the sentinel lives inside the script file, never on a command line, so the harness
cannot manufacture the false positive it is measuring):

```
--- A: curl --config -  (the pipeline construction)
argv of pid 33722:
curl --config -
sentinel hits in the whole process table: 1

--- B: curl -H "Authorization: Bearer <token>"  (the counterfactual)
argv of pid 33732:
curl -H Authorization: Bearer ghp_SENTINEL134NOTAREALTOKEN --config -
sentinel hits in the whole process table: 2
```

The baseline is **1**, which is the `grep` doing the counting — its own pattern is in its own argv.
Baseline-corrected: **A = 0 hits, B = 1 hit.** The pipeline's construction puts nothing in the
process table but `curl --config -`; the obvious `-H` form puts the credential there in full.

That baseline is the false positive NOTES §6 warned about, reproduced here deliberately. It is easy
to hit and easy to mis-report in either direction, which is why the counterfactual is measured rather
than assumed.

**Masking held, separately.** The credential is embedded mid-string inside a larger config value —
the case #133 flagged as the one to watch, being the first non-synthetic exercise of the v0.4.3
wrapper. From the successful run's `fetch-issues` `input.json`:

```
url = "https://api.github.com/repos/howardyang2009/PATH/issues?state=all&since=2026-07-27T07:17:33Z&per_page=100"
header = "Authorization: Bearer [secret:token]"
header = "Accept: application/vnd.github+json"
header = "X-GitHub-Api-Version: 2022-11-28"
silent
output = "issues.json"
write-out = "{\"http_code\":%{http_code},\"headers\":%{header_json}}"
```

Masking is by value, so the embedding did not matter. Note for anyone re-checking this: grepping the
run directory for `[secret:token]` returns 27 hits, and **most are not masking** — `issues.json`
contains this repository's own issue bodies, which discuss `$secret` and quote the placeholder. The
evidence is the `input.json` line above, not the grep count.

**Two narrowings of this `fine`, recorded because a decisive entry deserves them.**

1. **The second defeater was never tested.** Rubric §4 pre-registered a structural blocker: format
   §4.2 writes the step's input object to stdin, so `--config -` could collide with how the step is
   fed. No collision arose here **because a `GET` has no request body** — the config *is* the input,
   and stdin carries exactly one thing. A request needing both a body and a config on stdin would
   contend for the same single stream. This pipeline never issued one, so that defeater stands
   untested rather than refuted.
2. **`--config -` is a transport, not a guarantee.** Nothing in v0 prevents an author from writing
   `-H "Authorization: Bearer ${config.token}"`, and that form is shorter, more obvious, and is what
   every piece of documentation on the internet shows. The observation is that a safe form *exists
   and was used*, which is what the bar asks. It is not an observation that v0 steers anyone toward
   it.

Verdict `fine`. Rubric §3's decisive route runs through this entry alone; the fact that it is `fine`
is recorded here without any statement about what that does to the verdict.

### 2.7 `Q6` — locatability → **`unobservable`**

**Why, precisely.** The rubric does not merely ask whether the target is stateable; it fixes **who
does the stating**: *"a **human who did not write the workflow** — not the #133 agent, and not an
agent carrying #133's context"*, and adds that *"the observer's freshness is part of the
measurement"*. No such observer existed. #133 was executed by an agent, #134 was executed by an
agent, and by the time this file's author read the workflow it had already read #133's NOTES and
#131's shape document — that is, it is disqualified twice over by the entry's own wording.

This is rubric §2's definition exactly: the observation as written could not be made. It records as a
**fault in the standard**, not as a pass, and the fault is specific and worth naming for future
rubrics: **#130 specified a human observer for a map it knew would be executed by agents, and did not
say who would supply one or at what point.** Every other entry in this rubric is observable from
artifacts; this one alone requires a person, and no step of the map was ever scheduled to fetch one.

**Recording `unobservable` here is not a way to park an inconvenient entry**, and the arithmetic is
stated so that can be checked: it is the only `unobservable` verdict in this file, so §3's hole rule
(two or more) does not fire, and removing the entry from the denominator while the numerator stays at
3 makes the contributory route **harder** to meet, not easier. The verdict costs the door nothing and
gains it nothing.

**What a non-conforming reading found, recorded so a conforming observer has only to confirm or
overturn it.** Reading `github-release-notes.workflow.json` alone:

- **The headers are fully stateable.** Three of them are literal in the `fetch-issues` input string;
  the fourth is `Authorization: Bearer ${config.token}`, and `config.token` is
  `{"$secret": {"$env": "GITHUB_TOKEN"}}` at the top of the same file. One hop, no execution.
- **The host and path are stateable.** `${config.api_base}` and `${config.repo}` are both in `config`
  in the same file: `https://api.github.com/repos/howardyang2009/PATH/issues`.
- **The query is not, entirely.** `since=${context.since_date}` is published by a *different* node,
  `since-date`, whose args are a `sh -c` pipeline over `git log`. Stating what the request actually
  asks for requires reading a second node and evaluating a shell command in your head.

Against the bar — *"`pain` if the target cannot be stated from the file without executing or mentally
evaluating interpolation across more than one node"* — that last point reads as `pain`, and it is
HTTP-specific in this file: `fetch-issues` is the **only** node whose target requires crossing a node
boundary, while `gather-subjects`'s `git log … ${config.base_ref}..${config.head_ref}` is stateable
from `config` alone. Against that, the crossing is a single node and its meaning is recoverable
without running anything ("the committer date of `base_ref`").

**None of that is the verdict.** The verdict is `unobservable`, because the rubric made the reader
part of the measurement and no qualifying reader read the file. If #135 wants `Q6` scored, a human
who has not read #131 or #133 needs to read the workflow and answer the question; that reading would
convert this entry, and the paragraph above is what it would be confirming or overturning.

> **Converted at [#135](https://github.com/howardyang2009/PATH/issues/135): `unobservable` → `fine`.**
> The reading above was overturned — a human observer answered that an upstream node publishing
> `since_date` is ordinary authoring rather than an HTTP-specific locatability cost. Provenance and
> caveats (the observer is the map's author, and scored after the stakes were disclosed) are in
> [api-door-verdict.md §4](api-door-verdict.md). This paragraph is left as written; #134's record is
> not rewritten.

---

## 3. Unanticipated — pain the rubric did not pre-register

Per rubric §2, these count and can inform #135's reasoning and #109's trigger wording, but they carry
the caveat that they were not pre-registered and **do not count toward §3's threshold**.

### 3.1 `--fail`'s exit code is not 22, and depends on the HTTP version

Rubric §4 states as background that `--fail` gives *"one exit code 22 for every 4xx/5xx"*. On the
transport curl actually negotiates with `api.github.com`, it does not:

```
$ curl --fail -sS --http1.1 https://api.github.com/repos/howardyang2009/definitely-not-a-real-repo-134
exit=22  curl: (22) The requested URL returned error: 404
$ curl --fail -sS --http2   https://api.github.com/repos/howardyang2009/definitely-not-a-real-repo-134
exit=56  curl: (56) The requested URL returned error: 404
```

Same split on a `401` against `/user`: `22` under HTTP/1.1, `56` under the default. HTTP/2 is the
default against this host, so **the exit code an author would actually observe is 56**
(`CURLE_RECV_ERROR`), not the documented `22` (`CURLE_HTTP_RETURNED_ERROR`).

This changes nothing about the verdicts — the pipeline does not use `--fail`, having discarded it for
the structural reason in `Q2`. It matters because it makes the discarded route *worse* than the
rubric described: an author who reasoned "exit 22 means an HTTP error" would be wrong on the default
transport, and the status is still collapsed either way. It also means a `binary` step's exit code
can vary with a protocol negotiation that nothing in the workflow file mentions.

### 3.2 The timezone half of the `since` defect, which no rubric entry's counterfactual reaches

§2.2 records the two-hour error as `Q1b` evidence because its symptom is `Q1b`'s exactly — a `200`
carrying the wrong window, invisible to exit codes and checkpoints. It is repeated here because its
*cause* sits outside every counterfactual capability in the rubric, and #135 needs that separated
from the `+02:00` finding:

- A structured-pairs query encoder (`Q1b`'s counterfactual) would encode a wrong timestamp
  faithfully.
- A typed non-2xx failure (`Q2`'s) never fires; the request is a legitimate `200`.
- The value is wrong before HTTP is reached at all.

What it *is* attributable to is visible in `since-date`'s args: `TZ=UTC` has to be written inside
`sh -c`, because a `binary` step has no scoped environment (`binary-worker.ts:55` passes the parent
environment through unmodified) — and the author who reached for that prefix reasonably assumed it
would do something, when for `--date=format:` it does nothing. Scoped env for `binary` workers is a
separate parked door in #109. Per rubric §3's **frame rule**, pain concentrating in a counterfactual
a step type cannot deliver is evidence for #135's third outcome, not for the door. Flagged, not
weighed.

### 3.3 The top-line failure message does not name the status

The `401` run's terminal output was:

```
run failed: checkpoint "http-ok" failed: equals "context.meta.http_code" was false
```

An operator reading only that line knows a check failed, not that the call was unauthorized. The
information is not lost — the narrative event carries
`"trace":{"type":"equals","path":"context.meta.http_code","outcome":"false","value":401}`, and
`fetch-issues`'s `output.json` holds the whole envelope — so it is typed, persisted and reachable,
and only the top-line rendering is thin.

Recorded as unanticipated and as **not HTTP-specific**: an `equals` against a `grep` count would read
exactly as poorly. It is a condition-trace rendering observation. Per §3's frame rule it points away
from a step type.

### 3.4 A verification that runs through a filtering layer is not a verification

#133's pre-flight check of `extract-refs` reported **11** reference numbers; the pipeline's own run of
the identical command reported **24**, and the pipeline was right. The shell check was reading
truncated output — this session's shell routes `git` through a token-reducing proxy that elides long
output, and every `(resolves #94)`-style tail sat in the elided part. `grep -oE '#[0-9]+'` then
faithfully found only what survived truncation.

Nothing about the workflow was ever wrong. It is recorded here for two reasons. First, the shape of
the error is `Q1b`'s shape one layer out: a step that succeeds while carrying the wrong data,
invisible to exit codes and checkpoints, and it nearly propagated into #133's own write-up as a
finding. Second, what settled it was the run's persisted artifacts under `.path/` — which is an
argument for the artifacts, and the reason this file cites them in preference to any transcript.

No rubric entry covers the author's tooling, so this is unanticipated by construction rather than by
oversight.

### 3.5 Two shapes #133 declined to change, neither HTTP-specific

Both were settled in #131 §6 before #133 began, and #133's rule was that a v0 shape which feels wrong
is the deliverable rather than something to quietly correct. Carried forward here because #134 asked
whether #135 wants them:

1. **`have-citations` conflates "nothing to cite" with "the join broke."** The checkpoint is
   `exists context.enriched.cited.0.number`, so a commit range that legitimately references no issues
   fails the run rather than producing uncited notes. `exists` is the only predicate tolerant of an
   absent path, so the guard has no vocabulary for the distinction.
2. **`meta` is a generic publish key** for `{http_code, headers}`; `response_meta` would read better.

Neither is HTTP-specific, so neither is rubric material.

---

## 4. What this file deliberately does not do

- **No verdict on the door.** No tally, no application of §3's routes, no statement about whether the
  evidence clears the bar. #135 owns that, and #129 shaped this ticket as separate from #135 so the
  weighing could not be smuggled into the recording.
- **No edit to the rubric.** `Q6`'s fault is recorded as an `unobservable` verdict with its reason,
  which is the mechanism the rubric's preamble requires. `Q1b`'s missing `?q=` grammar is recorded as a narrowing
  of the evidence, not as a rewrite of the entry.
- **No fix to the two-hour `since` defect.** #133's constraint — a v0 shape that feels wrong is the
  deliverable, not a thing to fix — applies with more force to a defect that is this ticket's own
  sharpest piece of evidence. Fixing it would destroy it. Whether it gets fixed, and under which
  ticket, is downstream of #135.

## 5. Reproducing the probes

The three probes written for this ticket, in the order they appear above. None needs a credential;
all target the public `howardyang2009/PATH` repository and cost four requests in total.

```sh
# Q1b — the silently-wrong-200, four windows on one endpoint
B='https://api.github.com/repos/howardyang2009/PATH/issues?state=all&per_page=100'
for s in '2026-07-27T07:17:33Z' '2026-07-27T07:17:33+02:00' '2026-07-27T07:17:33%2B02:00' '2026-07-27T07:17:33%2002:00'; do
  printf '%s  ' "$s"; curl -s "$B&since=$s" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))'
done

# Q1b — the two-hour rendering defect, no network needed
git log -1 --format=%cI v0.4.1
TZ=UTC git log -1 --date=format:'%Y-%m-%dT%H:%M:%SZ'       --format=%cd v0.4.1   # the workflow's form
TZ=UTC git log -1 --date=format-local:'%Y-%m-%dT%H:%M:%SZ' --format=%cd v0.4.1   # the correct form

# Q2 — the exit code a 404 produces
printf 'url = "https://api.github.com/repos/howardyang2009/definitely-not-a-real-repo-134"\nsilent\noutput = "body404.json"\nwrite-out = "{\\"http_code\\":%%{http_code}}"\n' > cfg404.txt
curl --config - < cfg404.txt; echo " exit=$?"

# §3.1 — --fail's exit code by HTTP version
for v in --http1.1 --http2; do
  curl --fail -sS $v https://api.github.com/repos/howardyang2009/definitely-not-a-real-repo-134 >/dev/null
  echo "$v exit=$?"
done
```

`Q5`'s argv probe needs a longer-lived process and is given in full in §2.6; the script keeps its
sentinel inside the file rather than on a command line, which is what makes its baseline meaningful.

The run artifacts cited throughout are under `docs/dogfood/.path/runs/` — `7f549c03…` for the `401`,
`2f9f60df…` for the successful run. Root `.gitignore` excludes `.path/`, so they are local to the
machine that ran #133; `docs/dogfood/github-release-notes.sample-output.md` is the committed artifact
of that run.
