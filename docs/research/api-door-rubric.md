# API-endpoint door — pre-registered rubric

The standard by which [map #129](https://github.com/howardyang2009/PATH/issues/129) judges what `curl`-through-`binary` costs, fixed in [#130](https://github.com/howardyang2009/PATH/issues/130) **before any workflow JSON exists**.

**This file is frozen.** It is committed before [#133](https://github.com/howardyang2009/PATH/issues/133) writes its first line of workflow JSON, so the freeze is verifiable from git history rather than asserted. [#134](https://github.com/howardyang2009/PATH/issues/134) records observations in a **separate** file (`api-door-observations.md`) referencing the entry ids below; it does not edit this one. [#135](https://github.com/howardyang2009/PATH/issues/135) applies the weighing rule in §3 to what #134 wrote.

If an entry turns out to be wrong, the correction goes in the observations file as an `unobservable` verdict with the reason (§2), not as an edit here. A rubric the person who felt the pain can edit is not a rubric.

## 1. How an entry is written

Every entry has four parts:

- **Weight** — `decisive` or `contributory`, fixed here, never at record time.
- **Counterfactual capability** — what opening the door would buy, stated as a *capability*, never as a mechanism. "Headers reach the request without passing through argv" is in bounds; "a `headers` object field on the node" is not. Naming a mechanism here would design the step type, which #129 rules out of scope, and would foreclose #135's third outcome (the frame was wrong) before the evidence is in.
- **Observation** — the concrete thing #134 looks at.
- **Bar** — what makes it `pain`, and what makes it `fine`.

There is deliberately **no severity scale**. A 0–3 score would be assigned by the person who just spent an afternoon fighting the thing, against a scale nobody pre-committed to — which is the exact judgement pre-registration exists to remove. Magnitude is expressed once, in advance, as `decisive` vs `contributory`.

## 2. Verdict values

Each entry resolves to exactly one:

| Value | Meaning |
| --- | --- |
| `pain` | The bar for pain was met. |
| `fine` | The bar was not met. `curl` handled it. **Records with equal weight** — a clean entry is what keeps the door shut, and it is the one a motivated write-up thins out. |
| `unobservable` | The observation as written could not be made. A **fault in this standard**, not a pass. §3's hole rule applies. |
| `not-exercised` | The run never reached this. The standard is sound; the evidence is narrower. Counts toward neither side. |

`unobservable` and `not-exercised` are separate values because they mean opposite things to #135: one discredits the rubric, the other merely narrows what the run showed.

Pain the rubric did **not** anticipate is recorded in the observations file marked clearly as unanticipated. It counts, carrying the caveat that it was not pre-registered — it can inform #135's reasoning and #109's trigger wording, but it does not count toward §3's threshold.

## 3. Weighing rule

Fixed here, before either answer is known.

**Decisive route.** `Q5` at `pain` opens the door on its own. No other entry is decisive.

**Contributory route.** The door opens if **three or more counted contributory entries** are `pain`, **and at least one of them is `Q1b`, `Q2` or `Q3`.**

The guard exists because `Q1a`, `Q4` and `Q6` are the three softest items here — one measures a cost v0 already pays for `grep`, one may rest on a quarantined probe, one is a judgement about reading. Three of those alone must not open a door.

**Counting.**

- `not-exercised` and `unobservable` entries leave the denominator; the numerator stays **3**. If enough entries fall out, the contributory route simply cannot be met — the threshold does not scale down with the evidence. A shrinking denominator must never make the door *easier* to open.
- **Collapse:** if a single construction resolves both `Q2` and `Q3`, they are one finding. Recorded separately, **counted once**.
- The `Q4` forced-pagination probe (§4, `Q4`) is recorded as a note and **never counted**.

**Hole rule.** If **two or more** entries come back `unobservable`, this standard had a hole. #135 must say so plainly, and **may not open the door on contributory grounds**. The decisive route is unaffected — it does not run through the threshold.

**Frame rule.** If the pain concentrates in entries whose counterfactual capability **a step type cannot deliver** — process-boundary concerns, `while-do`/`publish` gaps, scoped env for `binary` workers — that is evidence for #135's third outcome (the frame was wrong: a `path`-native HTTP client, or a `binary`-worker concern), **not** for the door. Without this rule that outcome is decorative.

**Re-park.** If neither route is met, the door stays shut and #109's trigger is rewritten to say what would actually have to be true. Per #129 this is a **successful** outcome, equal to the others.

## 4. Entries

### Q1a — Shell quoting through `sh -c`

- **Weight:** contributory
- **Counterfactual capability:** a request is expressed without a shell in the path at all.
- **Observation:** what the GitHub call cost in quoting — JSON string escaping in the workflow file, shell quoting inside `-c`, and interpolation crossing both.
- **Bar:** `pain` **only if the difficulty is specific to the HTTP call** — something that would not have arisen writing the same value into a `grep` or `cat` step. Otherwise `fine`, with a note that the cost is general to `binary`.

**Why the discount.** `spawn(command, args, { cwd })` (`packages/engine/src/binary-worker.ts:55`) uses **no shell**; `sh -c` is an author's deliberate choice, taken whenever a pipe or redirect is wanted. v0 already takes it 5 times in 8 binary steps across `docs/dogfood/` and `docs/acceptance-workflow/`, already paying double-escaped backslashes:

```json
{ "command": "sh", "args": ["-c", "grep -E '^feat(\\([^)]*\\))?:' || true"] }
{ "command": "sh", "args": ["-c", "cat > \"${config.output_file}\""] }
```

An API-endpoint step type would fix only the HTTP slice of a cost that is general to `binary`. Scoring this `pain` without the comparison would put a `grep` cost on the door's ledger. A `pain` here that survives the discount is also a candidate for §3's frame rule.

### Q1b — URL and query construction

- **Weight:** contributory
- **Counterfactual capability:** a query is expressed as structured pairs and encoded for the author.
- **Observation:** building `?q=repo:owner/name+is:issue+closed:>=DATE` — what had to be hand-encoded, and **whether a mis-encoding produced a silently wrong request**: a 200 carrying the wrong result set rather than an error.
- **Bar:** `pain` if hand-encoding was required **and** a plausible mistake in it is invisible at run time. `fine` if encoding was mechanical, or if a mistake fails loudly.

The silent-wrong-200 is the sharpest observable in this rubric: it is invisible to exit codes, to checkpoints, and to tests alike, and neither `--fail` nor a judge step catches it.

### Q2 — A non-2xx arriving as a shell exit code

- **Weight:** contributory (see the collapse rule, §3)
- **Counterfactual capability:** a non-2xx arrives as a typed failure carrying its status, without the author reconstructing it from stdout.
- **Observation:** what it takes for a **checkpoint** to distinguish 404-not-found from 403-rate-limited from 500 — counting **every node that exists only to recover the status**.
- **Bar:** `fine` if **one** extra node suffices. `pain` at **two or more**, or if the construction breaks `parse: "json"`.

**The structural shape, from format §4.2 and `binary-worker.ts`.** v0 gives a typed failure **or** a body, never both:

- `--fail` → step fails, one exit code 22 for every 4xx/5xx, and a failed step publishes nothing, so the body is gone.
- no `--fail` → body on stdout, exit 0 always, no failure signal.
- `--fail-with-body` does not escape it: the exit is still non-zero, so the step still fails and the body still does not land.

The run's error text is `step "<id>" exited with code 22` plus the last 500 chars of stderr (`binary-worker.ts:91-95`). curl's `--fail` stderr does name the code, so a **human reading the log** can tell 404 from 500 — but a **checkpoint cannot**, because format §4.2 makes stderr audit-only and never data. Conditions read roots `context` and `output` only (format §9); there is no `config` root, itself a separate parked door in #109.

**Recorded prediction, not the bar:** the expected answer is **2** nodes — one to separate the status from the body (`-w`/`%{json}` contaminates the output object; `-D file` needs a reader), one checkpoint. If #133 finds a one-node form, that is a genuine update and scores `fine`. The prediction is written here so that finding cannot be retrofitted either way.

### Q3 — Response metadata reachable as data

- **Weight:** contributory (collapses with `Q2`, §3)
- **Counterfactual capability:** a response's headers are readable without contaminating the output object.
- **Observation:** reading `x-ratelimit-remaining` / `x-ratelimit-reset` — available on **every** call — and what it costs. `-i` and `-D -` mix headers into stdout and break `parse: "json"`; `-D file` needs a second step; `-w '%{header_json}'` replaces the body.
- **Bar:** same node count as `Q2`: `fine` at one extra node, `pain` at two or more or if `parse: "json"` breaks.

**This entry replaces "rate limits."** The authenticated limit is 5000/hr and the pipeline makes a handful of calls, so a rate limit will never fire; tripping one deliberately means burning 5000 requests, far past what #129 permits. Reading the header needs no rate limit and is observable on every call. A limit actually being hit is recorded as a note and nothing more — **retry, backoff and rate-limit handling are #109's third door and out of scope here** (#129). Reading a header is not retrying.

### Q4 — Pagination against the one-output-object rule

- **Weight:** contributory
- **Counterfactual capability:** N responses become one output object without the author hand-repairing concatenated JSON.
- **Observation:** how a paginated endpoint meets CONTEXT.md invariant 3 (one step, one output object). `publish` is a map of context-key ← **interpolated value** with `context` available as a root (format §6.2), so cross-iteration accumulation in a `while-do` is expressible only as **string concatenation** — there is no array-append, and concatenated JSON pages are not valid JSON, so accumulation costs a repair step.
- **Bar:** `pain` if accumulating pages required a repair step or a construction that defeats `parse: "json"`. `fine` if it fell out cleanly.

**Honest-exercise rule.** Pagination is observed only if the **real** commit range at a sensible `per_page` naturally spans pages. It probably will not. If it does not, the verdict is `not-exercised` and #135 may not count it **in either direction**.

**Quarantined probe.** #133 may additionally run one forced `per_page=1` pass to see the shape. It is recorded as a **note, explicitly labelled a probe, outside the count** (§3). #129 requires the workflow be real rather than a probe; shrinking `per_page` to manufacture evidence would violate that, so the quarantine is what lets the finding be captured without it becoming pipeline evidence.

Note this counterfactual is **not** obviously a step-type capability — it may be a `while-do`/`publish` gap, which routes to §3's frame rule.

### Q5 — The token in argv — **DECISIVE**

- **Weight:** **decisive.** `pain` here opens the door on its own.
- **Counterfactual capability:** a credential reaches the request without ever entering the process's argv.
- **Observation:** whether the pipeline could authenticate **without** the token entering argv, and if not, why not. Check `ps` against a live run.
- **Bar:** `pain` **iff no usable non-argv transport exists within `curl`-through-`binary` as v0 stands.** If one exists and #133 used it, `fine` — and the door does not open on security grounds.

**Why decisive.** mvp-spec.md:374 already records argv as the exposure `$env` was built to avoid, yet `curl -H "Authorization: Bearer ${config.token}"` splices the value straight back into argv where `ps` reads it. This is the one entry that is security-shaped rather than ergonomic, and #129 forbids weighing it as a mere convenience.

**Why masking does not cover it, and never could.** The step-run directory persists `input.json`, `output.json`, `stderr.txt` and `context.json` (`packages/engine/src/persistence/paths.ts:40-43`). **`command` and `args` are not persisted at all.** So argv exposure is not a gap in v0.4.3's masking — it is outside what persistence-boundary masking is. Nothing about `$secret` was ever going to reach the process table.

**Why decisive does not mean automatic.** `curl --config -` reads options from **stdin**, which would keep the header out of argv entirely. Two things could defeat it, and both are pre-registered here because they point at different verdicts:

1. **curl cannot do it usably** in the form v0 can author → `pain`, and the door opens on the decisive route.
2. **stdin is already spoken for.** Format §4.2 writes the step's **input object to stdin**. If `--config -` collides with how the step is fed, the blocker is structural to the `binary` step rather than a curl limitation — record it as `pain` **and flag it for §3's frame rule**, since a step type is then not obviously the fix.

### Q6 — Locatability

- **Weight:** contributory
- **Counterfactual capability:** the request's target is stated in one place a reader can find.
- **Observation:** reading the workflow file alone, without running it, **can a reader state which URL is called and with which headers?** A `git log` step's target is self-evident in its args; a curl call's may be assembled from a config key, an args element and an interpolation, in three places.
- **Bar:** `pain` if the target cannot be stated from the file without executing or mentally evaluating interpolation across more than one node. `fine` otherwise.
- **Who observes:** a **human who did not write the workflow** — not the #133 agent, and not an agent carrying #133's context.

This replaces "author readability", which #130 flagged as the weakest entry as stated. Readability is unfalsifiable and always available as a complaint; #133 is an agency ticket, so an AI-authored readability complaint about AI-authored JSON measures nothing. Locatability is binary, HTTP-specific, and a claim about a *reader* — which is why the observer's freshness is part of the measurement. The author is never a reader.

## 5. What this rubric is not

- Not a design. No entry names a field, a schema, or an engine change; #129 rules the step type's design out of scope, and §1's capability constraint is what enforces that.
- Not a retry argument. `Q3` reads a header; it does not handle a limit.
- Not a spec change. `release-notes.workflow.json` and spec §11's offline acceptance set are untouched by everything downstream of this file.
