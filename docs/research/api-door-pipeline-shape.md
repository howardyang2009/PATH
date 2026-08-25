# API-endpoint door — the enrichment pipeline's shape

This resolves [#131](https://github.com/howardyang2009/PATH/issues/131), the pipeline half of
[map #129](https://github.com/howardyang2009/PATH/issues/129)'s frontier. It settles **what
[#133](https://github.com/howardyang2009/PATH/issues/133) builds**: which GitHub endpoints the
release-notes enrichment calls, how a commit range becomes an issue set, the node list in format v0,
where the token enters, and what lands where on disk.

**It records no verdict against [the rubric](api-door-rubric.md).** That is
[#134](https://github.com/howardyang2009/PATH/issues/134)'s file. But §8 does something #130 did not
anticipate and #135 needs to know: a settle of this shape **answered several rubric entries on paper,
before #133 exists**. Where that happened it is named, so the boundary is visible rather than left for a
reader to police, and so #134 can record deltas rather than report confirmations as discoveries.

**Date:** 2026-08-02. **Verified from:** macOS 15 (arm64), `curl 8.7.1`, against live `api.github.com`.
**The live calls in this file were made unauthenticated** (`x-ratelimit-limit: 60`), because the
recorded credential is the human's and this document needed only response *shapes*.
[#132](https://github.com/howardyang2009/PATH/issues/132) §1 established that every candidate endpoint
returns `200` without a credential, which is what makes that substitution sound. §4 of that file is the
authority on the authenticated limits, not this one.

**No token value appears in this file.** The workflow references the credential only as
`{"$secret": {"$env": "GITHUB_TOKEN"}}`.

---

## 1. There is no API node, and that is the point

Format v0's node union is seven types: `prompt`, `binary`, `workflow`, `parallel`, `branch`, `while-do`,
`checkpoint` ([workflow-format-v0.md](../format/workflow-format-v0.md) §4). No HTTP type exists. §11
lists "API/MCP/skill step types" as deferred, and `mvp-spec.md:429` states the current answer outright:

```
| API-endpoint step type | curl via `binary` today; promote in v-next |
```

So the HTTP call in §5 is a `binary` step that spawns `curl`. To write `{"type": "api", …}` instead
would fail at load (§1 validates strictly, unknown `type` rejected before any step runs), would violate
#129's rule that the workflow be written **as the format stands today**, and would pre-empt the very
question the map exists to answer.

**The awkwardness of this node list is the deliverable.** It is what a real HTTP pipeline looks like
without an API node, and #134 measures it.

## 2. How a commit range becomes an issue set

**Decided: parse `#N` out of the commit subjects locally; that set is authoritative. One REST listing
call supplies titles and state. A local step joins them.**

The `#N` references are already in the history (`docs(changelog): v0.4.3 (#127)`,
`refactor(engine): … (resolves #94)`), and they are what `CHANGELOG.md` cites by hand today. To take
them from `git log` costs no HTTP call and needs no heuristic: the commits say which issues belong to the
range, because a human wrote them there.

Rejected, with reasons, because #131 asks that the alternatives be on the record:

| Option | Rejected because |
| --- | --- |
| Resolve each `#N` via `GET /issues/{N}` | N calls, and v0 has no `foreach`. Fan-out is a `while-do` with a cursor in context, and `publish` is context-key from an interpolated value with no array-append (format §6.2), so accumulation is string concatenation and concatenated JSON pages need a repair step. A real cost paid for a precision the listing already gives. |
| Date window only, no `#N` parsing | "Belongs to the range" degrades to "was closed around then". Issues no commit touched get cited anyway, and correctness moves into the LLM's prose. |
| Merged-PR association | `compare` for the shas, then `/commits/{sha}/pulls` per sha — the same fan-out, and the closing-issue link is reachable only in GraphQL, not REST. |

**The listing is a window, so it can miss.** A `#N` closed long before the range, or one that points at
another repository, will not come back. So §6's join step emits `unresolved` alongside `cited`, and the
draft step is told to name the unresolved numbers rather than describe them. Nothing is silently dropped
and nothing is invented, which matters, because the enrichment exists precisely because hand-typed
citations are unreliable.

## 3. Which API surface: REST

**Decided: `GET /repos/{owner}/{repo}/issues?state=all&since=<base-commit-date>&per_page=100`.**

Measured against the live endpoint for the `v0.4.1..v0.4.3` range:

| Observation | Value |
| --- | --- |
| Status | `200` |
| Items returned | **57** |
| Issue numbers spanned | `#81`–`#137` |
| Of those, pull requests | **26** |
| `Link` header | **absent** |

Three things follow. The `issues` endpoint returns **pull requests as well as issues** (they carry a
`pull_request` key), so one call covers "closed issues and merged PRs", no second endpoint. Every
reference in the range (`#94`–`#127`) falls inside the window. And at 57 of a 100 cap, **pagination does
not fire**.

**`/search/issues` was rejected**, though rubric `Q1b` names its `?q=` string as the observation to
make. #132 §5 records search as a separate rate-limit resource at **30 requests per minute** rather than
part of the 5000/hour `core` pool, and the plain listing answers the question without it. To choose an
endpoint because the rubric anticipated it would be to design the pipeline to produce evidence, which
#129 forbids. The consequence is stated plainly for #134: **`Q1b` is exercised more softly than the
rubric expected**. Query construction is still hand-built, and §7 shows a live silently-wrong-`200`
hazard in it, but there is no `?q=` grammar to mis-encode.

**GraphQL was rejected** on a structural collision, not a preference. A POST body must reach `curl`
either through `-d @-` (stdin) or `-d '<query>'` (argv). Format §4.2 gives a `binary` step **one** stdin,
and §4 below spends it on the credential. GraphQL would therefore force either the query or the token
into argv, which forecloses `Q5`'s answer before it could be observed. A GET has no body, which is what
leaves stdin free.

## 4. Where the token enters: `--config -` on stdin, never argv

**Decided: the step's `input` string *is* the curl config, which carries both the URL and the
`Authorization` header. The credential never enters argv.**

This is rubric `Q5`, the sole decisive entry, and its bar is: `pain` **if and only if no usable non-argv
transport exists within `curl`-through-`binary` as v0 stands. If one exists and #133 used it, `fine`.**

**One exists.** `binary-worker.ts:106` writes the step's input to the child's stdin unconditionally.
`curl --config -` reads its options from stdin. Both were exercised live on `curl 8.7.1`. `Q5`'s
pre-registered defeater ("stdin is already spoken for", because format §4.2 writes the input object
there) **does not fire**, because a GET fetch step needs no upstream data on stdin. The collision the
rubric reserved is real in general and simply absent in this shape.

Under this form:

- `ps` shows `curl --config -` and nothing else.
- The value still arrives as `{"$secret": {"$env": "GITHUB_TOKEN"}}`, as #129 locked, so the run is the
  **first non-synthetic exercise of the v0.4.3 wrapper**.
- The credential *does* reach the persisted `input.json` (`persistence/paths.ts:40-43`) as part of a
  larger string, and is scrubbed to `[secret:token]` there, because masking is by value across every
  persisted artifact. Whether it survives being embedded mid-string is exactly the "masking surprise"
  #133 is told to watch for.

Alternatives, named because #131 holds that *whether an alternative exists and is usable* is itself
evidence about the door:

| Transport | Usable? | Why not chosen |
| --- | --- | --- |
| `-H "Authorization: Bearer …"` | yes | Splices the credential into argv, where `ps` reads it — the exposure `mvp-spec.md:374` says `$env` exists to avoid. `command` and `args` are **not persisted at all**, so masking never touches it. To choose this while §4's form works would manufacture a `pain` verdict against a bar that requires no alternative to exist. |
| `--variable %GITHUB_TOKEN` + `--expand-header` | **yes**, verified on 8.7.1 | Cleanest on exposure — `curl` reads the environment itself (`spawn(command, args, { cwd })` at `binary-worker.ts:55` passes the parent environment through), so the value touches neither argv nor config nor `input.json`, and stdin stays free. Rejected because it routes around `{"$secret": {"$env": …}}` entirely, and #129 locks that wrapper as the thing the run must exercise. **Recorded as a second usable non-argv transport**, which strengthens `Q5`'s `fine` rather than merely permitting it. |
| `--netrc-file <path>` | no | Writes the credential to disk, and gives Basic auth rather than a bearer header. Strictly worse than argv on the axis that matters. |
| `--config <file>` | no | Same objection: the credential lands in a file. |

## 5. The response: a typed envelope on stdout, body to a file

**Decided: `curl` writes the body to a file and emits a JSON envelope on stdout that carries `http_code`
and the full response header set. The fetch step declares `parse: "json"`, and checkpoints read the
envelope as typed data.**

The structural problem rubric `Q2` names is real: v0 gives a typed failure **or** a body, never both.
`--fail` fails the step, and a failed step publishes nothing, so the body is gone. Without `--fail` the
exit is always 0 and there is no failure signal. `--fail-with-body` does not escape it.

The escape is to stop use of the exit code as the status channel. `output =` displaces the body to a
file, which frees stdout for a `write-out` envelope:

```
write-out = "{\"http_code\":%{http_code},\"headers\":%{header_json}}"
```

Verified live, on both paths:

```
200 → {"http_code":200,"headers":{…,"x-ratelimit-remaining":["51"],…}}   exit 0
404 → {"http_code":404,…}                                                exit 0
```

**A 404 exits 0 and still emits the envelope**, so a checkpoint *can* distinguish 404 from 403 from 500:
typed, on a number, in one construction. Three details make it work, and all three are load-bearing:

1. **`%{header_json}`, not `%header{name}`.** The raw form inserts unescaped bytes, and a real `Link`
   value contains `rel="next"`, double quotes inside a hand-built JSON string. Verified: it produces
   invalid JSON and breaks `parse: "json"` **exactly when a next page exists**, which is the one case the
   check is for. `%{header_json}` escapes properly.
2. **Header keys survive the dot-path grammar.** `SEGMENT_PATTERN` at
   `packages/schema/src/dot-path.ts:13` is `/^(?:[A-Za-z_][A-Za-z0-9_-]*|\d+)$/`. Hyphens are legal after
   the first character, so `context.meta.headers.x-ratelimit-remaining` resolves. Values are **arrays**
   (headers may repeat), hence the trailing `.0`.
3. **`exists` is the only predicate tolerant of an absent path** (`condition.ts`, and mvp spec §5.2).
   Every other one treats it as an `error` that fails the checkpoint. The single-page guard is therefore
   `not exists`, never `matches`. On the happy path the `Link` header is simply absent, and a `matches`
   against it would fail every successful run.

**Cost, for #134 to count:** exactly **one** node exists only because the body was displaced, the
`read-body` step. `Q2`'s bar is `fine` at one extra node. The response headers come free in the same
construction, so per §3's collapse rule `Q2` and `Q3` are one finding, recorded twice and counted once.

**Pagination is met by refusal, not accumulation.** `per_page=100` silently truncates at 101 items, so
the `single-page` checkpoint fails the run when GitHub reports a next page. The pipeline never drafts
notes from a truncated set. This is not retry or backoff (#129 puts those in #109's third door); it is a
correctness guard that costs zero extra nodes. Per `Q4`'s honest-exercise rule the real range does not
span pages, so `Q4` is **`not-exercised`**. #133 may still run the quarantined `per_page=1` probe,
recorded as a note outside the count.

## 6. The node list

Twelve nodes: seven `binary`, four `checkpoint`, one `prompt`. The file-level worker is `{ "type":
"engine" }` like `changelog.workflow.json` next door, with a single override to `llm` on the drafting
step, the inverse of `release-notes.workflow.json`, because here most nodes are binary.

```json
{
  "format": "path/workflow@0",
  "name": "github-release-notes",
  "worker": { "type": "engine" },
  "config": {
    "repo": "howardyang2009/PATH",
    "repo_path": "../..",
    "base_ref": "v0.4.1",
    "head_ref": "v0.4.3",
    "api_base": "https://api.github.com",
    "token": { "$secret": { "$env": "GITHUB_TOKEN" } },
    "model": "claude-sonnet-5",
    "body_file": "issues.json",
    "output_file": "release-notes-enriched.md"
  }
}
```

`base_ref` and `head_ref` are **two keys rather than one `commit_range`** because node 4 needs the base
ref alone and v0 has no string-splitting. `git log` gets `${config.base_ref}..${config.head_ref}`
spliced.

| # | Id | Type | What it does | Publishes |
| --- | --- | --- | --- | --- |
| 1 | `gather-subjects` | binary | `git log --no-merges --format=%s <range>`, `cwd: ${config.repo_path}` | `raw_subjects` |
| 2 | `have-changes` | checkpoint | `matches context.raw_subjects` `\S` — fail fast on an empty range | — |
| 3 | `extract-refs` | binary | `sh -c "grep -oE '#[0-9]+' \| tr -d '#' \| sort -un \|\| true"` over stdin | `ref_numbers` |
| 4 | `since-date` | binary | `sh -c "TZ=UTC git log -1 --date=format:'%Y-%m-%dT%H:%M:%SZ' --format=%cd <base> \| tr -d '\n'"` | `since_date` |
| 5 | `fetch-issues` | binary | `curl --config -`, input is the curl config, `parse: "json"` | `meta` |
| 6 | `http-ok` | checkpoint | `equals context.meta.http_code` `200` | — |
| 7 | `single-page` | checkpoint | `not exists context.meta.headers.link` | — |
| 8 | `read-body` | binary | `cat ${config.body_file}`, `parse: "json"` | `all_issues` |
| 9 | `join-refs` | binary | `node join-issue-refs.js`, input `{refs, issues}`, `parse: "json"` | `enriched` |
| 10 | `have-citations` | checkpoint | `exists context.enriched.cited.0.number` | — |
| 11 | `draft-notes` | prompt | worker override to `llm`; input `{cited, unresolved, subjects}` | `notes` |
| 12 | `write-file` | binary | `sh -c 'cat > "${config.output_file}"'` | `file` |

The fetch node in full, the one place the shape is not obvious from the table:

```json
{
  "type": "binary",
  "id": "fetch-issues",
  "input": "url = \"${config.api_base}/repos/${config.repo}/issues?state=all&since=${context.since_date}&per_page=100\"\nheader = \"Authorization: Bearer ${config.token}\"\nheader = \"Accept: application/vnd.github+json\"\nheader = \"X-GitHub-Api-Version: 2022-11-28\"\nsilent\noutput = \"${config.body_file}\"\nwrite-out = \"{\\\"http_code\\\":%{http_code},\\\"headers\\\":%{header_json}}\"\n",
  "command": "curl",
  "args": ["--config", "-"],
  "parse": "json",
  "publish": { "meta": "${output}" }
}
```

`join-issue-refs.js` emits `{ "cited": [{number, title, state, is_pr, url}], "unresolved": [N, …] }`, in
the shape `format-changelog.js` already sets next door. Node 11 receives both and is instructed to cite
the resolved records and merely *name* the unresolved numbers.

**Node 11 sits last deliberately.** Every HTTP failure during #133's iteration happens before an LLM
call is paid for.

## 7. Two encoding traps, recorded rather than hidden

Both live in node 4's output that feeds node 5's URL, and both are rubric `Q1b` material: a mistake in
either yields a **`200` that carries the wrong result set**, invisible to exit codes, checkpoints, and
tests alike.

1. **`--format=%cI` emits a trailing newline.** Spliced into a curl config line it corrupts the request.
   Hence the `tr -d '\n'`.
2. **`--format=%cI` emits `+02:00`.** An unencoded `+` in a query value is decoded by the server as a
   **space**. The request still returns `200`, with a different window than the author intended. Hence
   `TZ=UTC` and a `Z`-suffixed `--date=format:`, verified to produce `2026-07-27T07:17:33Z`, 20 bytes, no
   `+`, no newline.

The second is the sharpest thing in this design, and it is worth stating why it is not solved by care.
**`TZ=UTC` has to be inside `sh -c`**, because a `binary` step has no scoped environment. That is a
separate parked door in [#109](https://github.com/howardyang2009/PATH/issues/109), and
`binary-worker.ts:55` passes the parent environment through unmodified. Per §3's frame rule, a `pain`
recorded here points at a `binary`-worker concern rather than at an API step type, and #134 should say so
if it records one.

A third, smaller: `%{http_code}` is written **once** in a curl config file. The doubled `%%` in this
document's shell transcripts is `printf`'s escaping, not `curl`'s. #133 must not copy the doubled form.

## 8. Provenance — what this shape cost to find, and what it pre-answers

#133 is told to build, run, and **keep the wreckage**, because that wreckage is #134's evidence. A settle
of this shape consumed some of it in advance. Recorded here so #134 can attribute rather than re-derive,
and so #135 can tell a confirmed answer from a discovered one.

**Four live `curl` invocations** produced §3, §4, and §5. The path through them:

- `--fail` was discarded on reading, not on running: format §4.2 plus `binary-worker.ts:91-95` say a
  failed step publishes nothing, so the body is gone with the status.
- `-i` and `-D -` were discarded for the same structural reason: both mix headers into stdout and break
  `parse: "json"`.
- `output =` plus `write-out` was the first construction that separated them, and it worked on the first
  attempt, including the 404 path.
- `%header{name}` looked sufficient and **was wrong**: it took a deliberate `per_page=1` call to surface
  a real `Link` header and see the unescaped quotes break the parse. `%{header_json}` was the fix. This
  is the only place in the design where a plausible reading of the manual produces a construction that
  fails only under the condition it exists to detect.

**State of the rubric before #133 starts:**

| Entry | State | Where |
| --- | --- | --- |
| `Q1a` shell quoting | partial — four `sh -c` steps and a multi-line curl config as a JSON string; whether the difficulty is HTTP-specific is unmeasured | §6 |
| `Q1b` query construction | **hazard identified, not yet hit through the engine** — the `+02:00` silently-wrong-`200`; softened by the absence of `?q=` | §3, §7 |
| `Q2` non-2xx as exit code | **answered on paper** — one extra node, typed checkpoint on `http_code` | §5 |
| `Q3` header reachability | **answered on paper** — free in the same construction; collapses with `Q2` | §5 |
| `Q4` pagination | **answered** — 57 items, no `Link`; `not-exercised` | §3, §5 |
| `Q5` token in argv | **answered on paper** — two usable non-argv transports exist, one is used | §4 |
| `Q6` locatability | **untouched** — cannot be observed until the file exists, and needs a reader who did not write it | — |

What a live run still adds, and a shell cannot: engine **interpolation into the multi-line curl-config
string** (a splice of a non-scalar is a runtime error, and this is the first string of its kind);
**`$secret` masking a credential embedded mid-string** in `input.json`; **checkpoints that read
`parse: "json"` output** of a hand-built envelope; `Q6`; and unanticipated pain, which is the rubric's
own category and historically the one that carries.

**The likely consequence, stated in advance so it is not a surprise later.** `Q5` at `fine` closes the
decisive route. `Q2`/`Q3` collapsing at `fine` and `Q4` at `not-exercised` leave the contributory route
in need of three `pain` entries including one of `Q1b`/`Q2`/`Q3`, realistically `Q1b` alone, alongside
`Q1a` and `Q6`. **Re-park is the probable verdict.** #129 calls that a successful outcome, equal to the
others, and the rubric was frozen before this file existed precisely so it could happen. #135 owns the
weighing; this note is here so nobody mistakes the outcome for a failure of the map.

## 9. What #131 ships, and what #133 ships

| Ticket | Files |
| --- | --- |
| #131 (this) | `docs/research/api-door-pipeline-shape.md` |
| #133 | `docs/dogfood/github-release-notes.workflow.json`, `docs/dogfood/join-issue-refs.js`, `docs/dogfood/github-release-notes.NOTES.md`, `docs/dogfood/.gitignore`, `docs/dogfood/github-release-notes.sample-output.md` |

The split mirrors how the rubric landed before any workflow JSON existed: this ticket decides and
records, #133 builds and runs.

Run recipe, for the NOTES.md #133 writes: `read -rs GITHUB_TOKEN && export GITHUB_TOKEN` (#132 §3 —
never a command line the shell records), then
`npx tsx packages/engine/bin/path.ts run docs/dogfood/github-release-notes.workflow.json` from the repo
root.

**On disk.** `issues.json` (the curl body) and `release-notes-enriched.md` (the run's output) land in
`docs/dogfood/`, which is the default `cwd` for a `binary` step, the workflow file's own directory
(format §4.2). So neither needs a `work_dir` config key nor a `mkdir` node. A new `docs/dogfood/.gitignore`
covers both. Root `.gitignore` already carries `.path/`, so **no run directory is reachable in the
repo**. #133 therefore commits one captured run's notes as `github-release-notes.sample-output.md`, which
is the only artifact #134 and #135 readers can actually see.

**Not touched:** `release-notes.workflow.json` and spec §11's offline acceptance set, per #129.

## 10. What this document is not

- **Not a design for the step type.** No field, no schema, no engine change. #129 rules that out of
  scope; if the door opens it is the next map's destination.
- **Not a verdict.** §8's expectation is an expectation. #134 records, #135 weighs.
- **Not an edit to the rubric.** Where §3 and §7 note that `Q1b` is exercised more softly than #130
  anticipated, that is a fact for #134 to record against the frozen entry, not a licence to reword it.
