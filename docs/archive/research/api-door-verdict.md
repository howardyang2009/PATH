# API-endpoint door — the verdict

The weighing of [#134](https://github.com/howardyang2009/PATH/issues/134)'s observations
([api-door-observations.md](api-door-observations.md)) against the rubric fixed in
[#130](https://github.com/howardyang2009/PATH/issues/130) ([api-door-rubric.md](api-door-rubric.md)),
under the weighing rule that rubric fixed. Resolves
[#135](https://github.com/howardyang2009/PATH/issues/135) and reaches the destination of
[map #129](https://github.com/howardyang2009/PATH/issues/129).

**Date:** 2026-08-02.

---

## 1. The verdict

**The door stays shut.** The `API-endpoint step type` door in
[#109](https://github.com/howardyang2009/PATH/issues/109) is **re-parked with a sharper trigger**,
outcome 2 of the three #135 made available.

Neither of rubric §3's two routes was met. The decisive route did not fire, because the entry that runs
it came back `fine`. The contributory route reached **2 of the 3** it requires.

Per #129's locked decisions and rubric §3, this is a **successful** outcome, equal to the other two. A
map that could only conclude "build the step type" would not have been gathering evidence.

The evidence did not merely fail to clear the bar; it **falsified half of the trigger that was already
on the register**. #109 stated the cost as "shell quoting on every call" plus a non-2xx arriving as a
shell exit code. The first of those is wrong: the `curl` node is the one node in the shipped workflow
with **no shell in its path at all**. Only the second survived. §5 is the corrected trigger.

---

## 2. The tally

| Entry | Weight | Verdict | Counted toward §3 |
| --- | --- | --- | --- |
| `Q1a` shell quoting through `sh -c` | contributory | `fine` | — |
| `Q1b` URL and query construction | contributory | **`pain`** | **1** |
| `Q2` non-2xx as a shell exit code | contributory | **`pain`** | **1** (collapsed with `Q3`) |
| `Q3` response metadata as data | contributory | **`pain`** | counted within `Q2` |
| `Q4` pagination | contributory | `not-exercised` | — (neither direction) |
| `Q5` token in argv | **decisive** | `fine` | — |
| `Q6` locatability | contributory | `fine` (converted at #135, §4) | — |

**Counted contributory `pain`: 2.** The threshold is 3.

---

## 3. The routes, applied one by one

A route that does not fire is a finding, so all four of §3's rules are recorded, including the two that
changed nothing.

### 3.1 Decisive route — did not fire

§3: *"`Q5` at `pain` opens the door on its own. No other entry is decisive."*

`Q5` is `fine`. `curl --config -` reads its options from stdin. The engine writes the step's input to
the child's stdin from Node (`binary-worker.ts:106`), so the credential never passes through a shell and
never enters argv. Observations §2.6 measured it live against `ps`, with the `-H` counterfactual
measured in the same script: baseline-corrected, the pipeline construction put **0** sentinel hits in
the process table, and the obvious `-H` form put **1**.

This is the entry #129 flagged as the one that is security-shaped rather than ergonomic, and it is the
entry that would have opened the door alone. It came back clean. **The door does not open on security
grounds**, and that is the single most load-bearing finding in this file.

The bar was self-cancelling by design: `pain` *only if no usable non-argv transport exists*. One exists,
and #133 used it.

### 3.2 Contributory route — reached 2 of 3

§3: *"The door opens if **three or more counted contributory entries** are `pain`, **and at least one of
them is `Q1b`, `Q2` or `Q3`.**"*

Two counted. The guard clause is satisfied (both counted findings are in the hard set), but the
threshold is not, and §3 fixes the numerator at 3 regardless of how many entries leave the denominator.
A shrinking denominator must never make the door easier to open.

**The collapse ruling, which is the whole tally.** §3: *"if a single construction resolves both `Q2` and
`Q3`, they are one finding. Recorded separately, **counted once**."* Observations §1 state the factual
precondition is met and leave the rule unapplied, as #134 was required to. Applied here: **collapse
holds, and the two entries count once.**

The construction is one thing (`output = issues.json` diverts the body so the `write-out` envelope can
own stdout), and the two extra nodes it costs, `read-body` and `http-ok`, are the *same* two nodes for
both entries. Observations §2.4 concede the point directly: `Q3` scores `pain` only because its bar
defers to `Q2`'s count, and *"had headers been the only requirement, with no status check, the
construction would cost **one** extra node and would score `fine` standing alone."*

The counter-argument, recorded rather than left out: `Q2` and `Q3` carry different counterfactual
capabilities (a typed failure versus readable headers), so a reader could call them two distinct costs
that merely share a workaround. **Rejected**, because §3's rule keys on *construction*, not on
capability, and because a refusal to collapse would bill one construction twice to reach a threshold.
That is precisely what the rule was pre-registered to prevent, and the pre-registration is worthless if
it is set aside at the moment it binds.

Without the collapse, the count is 3, `Q1b` satisfies the guard, and the door opens. **The verdict turns
on this single ruling, and it is stated here in the open for that reason.**

**Why `Q2`/`Q3` is nonetheless real, and is the finding the new trigger is built on.** v0 gives a typed
failure *or* a body, never both. `--fail` collapses every 4xx/5xx to one exit code, and a failed step
publishes nothing, so the body is gone. Without `--fail` the body lands and there is no failure signal at
all. To recover a status therefore costs two extra nodes against the counterfactual where the status is
not needed, 3 nodes rather than 1, exactly the count rubric §4 pre-registered as its prediction.
Observations §2.3 also record the one-node form that *was* available to this particular pipeline
(`join-issue-refs.js` could have read `issues.json` off disk itself) and the three reasons it does not
fire the rubric's update clause: it was not built, it is available only because a custom script happened
to be the next consumer, and it buys the node back by a give-up of `parse: "json"` and a move of an
undeclared file read out of the workflow file. **That ruling is upheld**: the update clause is
conditional on #133 *finding* a one-node form, and #133 shipped the two-node one.

### 3.3 Hole rule — dead, not merely unfired

§3: *"If **two or more** entries come back `unobservable`, this standard had a hole."*

#134 recorded exactly one (`Q6`), so the rule did not fire on its arithmetic. §4 below converts that
entry, which leaves **zero**. The standard did not have a hole; it had an entry no one had been
scheduled to observe, and #135 supplied the observer.

### 3.4 Frame rule — does not fire

§3: *"If the pain **concentrates** in entries whose counterfactual capability a step type cannot
deliver … that is evidence for #135's third outcome, **not** for the door."*

It does not concentrate there. Of the counted findings:

- **`Q2`/`Q3`** — a typed non-2xx that carries its status, and headers readable without a contamination
  of the output object. A step type delivers both. Step-type-shaped.
- **`Q1b`, the `+02:00` half** — an unencoded `+` decoded server-side as a space, which produces a `200`
  over a different window. A structured-pairs encoder delivers it. Step-type-shaped.
- **`Q1b`, the timezone half** — **not** step-type-shaped. §6 below.

Two of the three counted findings sit squarely inside what a step type could deliver, so the rule's
trigger word is not met and **outcome 3 is not the verdict**. The part that does sit outside is recorded
in §6 as a named secondary finding, because #135 requires outcome 3's content to be said plainly
wherever it is true, and because a rule that never gets applied is decorative.

### 3.5 Re-park — this is the outcome

§3: *"If neither route is met, the door stays shut and #109's trigger is rewritten to say what would
actually have to be true."* §5 is that rewrite.

---

## 4. `Q6` converted: `unobservable` to `fine`

Observations §2.7 recorded `Q6` as `unobservable` and left the door open: *"If #135 wants `Q6` scored, a
human who has not read #131 or #133 needs to read the workflow; that reading would convert this entry."*
It was converted here, and the provenance is recorded in full, because a converted entry with an
unstated provenance is worse than an unconverted one.

**The observation.** Asked the rubric's question (from a read of `github-release-notes.workflow.json`
alone, can the target be stated without an execution or a mental evaluation of interpolation across more
than one node), the map's author answered that the URL and headers were stateable, and that
`since=${context.since_date}` being published by an upstream node is **ordinary authoring rather than an
HTTP-specific locatability cost**: an API-endpoint node depends on a prior node that establishes its
window, and to know that is part of writing it.

**Verdict `fine`.**

**Three caveats, none of which the arithmetic depends on.**

1. **The observer is the map's author**, and so is fresh with respect to #131's shape document and
   #133's NOTES, but is not a stranger to the map.
2. **It was scored after the stakes were disclosed.** The observer knew, before answering, that `pain`
   here would have made the count 3 and opened the door. Full stakes-disclosure before observation is
   exactly what rubric §1's pre-registration exists to prevent, and it cannot be undone.
3. **The disclosure pressure ran against this answer, not with it.** A contaminated observer with a
   motive would have scored `pain` and opened the door; this observer scored the entry the way that
   keeps it shut. That is the direction in which a contaminated `fine` is safe to accept, and it is the
   only reason this conversion is recorded as evidence rather than as a note.

**What it changes:** nothing in the tally. `Q6` moves from outside the denominator to inside it as a
`fine`, and the counted `pain` total stays at 2. What it does change is §3.3: the standard is no longer
carrying an unobservable entry, so no future reader need treat this verdict as resting on a holed rubric.

**The fault in the standard stands anyway, and is worth carrying forward:** #130 specified a **human**
observer for a map it knew would be executed by agents, and never said who would supply one or at what
point. It was supplied at the last possible ticket, by the one participant who could not be fresh. A
future rubric that makes an observer part of a measurement must schedule the observer.

---

## 5. What the record now says

### 5.1 #109 — the `API-endpoint step type` entry

The trigger is replaced. The old wording (*"a second real workflow that calls an HTTP API … which pays
shell quoting on every call and turns a non-2xx into a shell exit code rather than a typed failure"*)
fails twice over as a trigger:

- **It has already fired.** #133 built exactly that second real workflow, and the door did not open.
  Left as-is, it sends the next reader to re-run this experiment.
- **Half of its stated cost is false.** Shell quoting came back `fine` (`Q1a`). The `curl` node uses no
  shell; every `sh -c` in the workflow is there for a pipe, a redirect, or an environment prefix, which
  is a cost general to `binary` that v0 already pays for `grep` and `cat`. The one HTTP-specific escaping
  cost (depth-3 escaping in the `write-out` envelope, the only such construction in the repository) was
  expressible, correct on the first attempt, and fails loudly when mis-written.

The new trigger names the count, the two open candidates that would reach it, and the two questions that
are now closed. It is recorded in #109 and reproduced here:

> **Trigger:** a workflow that needs a non-2xx to reach a **checkpoint** as a typed status — not a
> second HTTP workflow, which #133 built without opening this door. `curl --config -` answered the two
> costs originally cited here: the credential stays out of argv (`Q5`, `fine`) and the request needs no
> shell at all, so the quoting cost named above was general to `binary`, not to HTTP (`Q1a`, `fine`).
> What did not resolve is status-and-body: v0 gives a typed failure *or* a body, never both, so
> recovering a status costs **two extra nodes** — a reader and a checkpoint (`Q2`/`Q3` collapsed,
> `pain`). **One more counted `pain` entry opens this door.** The two open candidates are **pagination
> against the one-output-object rule** (`Q4`, `not-exercised` — needs a real endpoint whose natural page
> span exceeds one) and **a query grammar with more to mis-encode than `since=`**, e.g.
> `/search/issues`'s `?q=` (`Q1b` scored `pain` on the softer instance).

### 5.2 mvp-spec §10

The row said *"curl via `binary` today; promote in v-next"*. "Promote in v-next" is the claim this map
was chartered to test and did not sustain, and a spec row that promises a promotion while the register
records a re-park is the same two-sections-disagreeing failure #128 had to settle for `extends`. The row
now records that a real HTTP workflow did not promote it, and points at #109 for the trigger. **The row
stays.** Unlike `$env`'s, which was retired because it shipped, this door is still a door.

### 5.3 No follow-on map

#135's outcome 1 would have named one. It does not apply. Nothing about the step type's design (format
shape, schema ownership, engine reader, failure typing) is charted by this verdict, and #129 rules it out
of scope.

---

## 6. The secondary finding: the pain that no step type reaches

Recorded plainly because #135's outcome 3 requires it wherever it is true, even when it is not the
verdict.

**The sharpest single artifact this map produced is not an HTTP problem.** The pipeline's `since` window
is two hours late. `TZ=UTC git log --date=format:'…Z'` renders in the **commit's own** timezone and
ignores `TZ` (only `format-local:` converts), and the `Z` in the format string is a literal character
that asserts UTC without making it UTC. The commits were authored in Berlin, so the offset is `+02:00`,
and the shipped window silently excludes anything updated in those two hours (observations §2.2: 60 items
at the correct `since`, 59 at the shipped one, `#80` dropped). The #133 run's output was correct **by
luck**: no commit in `v0.4.1..v0.4.3` cites `#80`.

Observations §2.2 record this as `Q1b` evidence because its *symptom* is `Q1b`'s exactly: a `200` that
carries the wrong window, invisible to exit codes, checkpoints, and tests alike. But its *cause* reaches
no counterfactual capability in the rubric:

- A structured-pairs query encoder would have faithfully encoded a wrong timestamp.
- A typed non-2xx never fires; the request is a legitimate `200`.
- **The value is wrong before HTTP is reached at all.**

What it is attributable to is that `TZ=UTC` had to be written inside `sh -c`, because a `binary` step has
no scoped environment (`binary-worker.ts:55` passes the parent environment through unmodified), and the
author who reached for that prefix reasonably assumed it would do something.

**A correction to two documents, since it affects where this finding could land.** Observations §3.2 and
rubric §3 both describe *"scoped env for `binary` workers"* as **"a separate parked door in #109"**. **It
is not.** #109's parked table has no scoped-env row, and neither does mvp-spec §10. The finding is real;
the door it was said to belong to does not exist. **No register row is opened here** (the map's author
ruled the timezone behaviour known and acceptable, no action required), so this is recorded as a finding
without a door, and a future reader who wants one must open it deliberately rather than assume it is
already there.

**The defect itself is not fixed.** #133's rule was that a v0 shape which feels wrong is the deliverable
rather than something to quietly correct, and it applies with more force to a defect that is this map's
sharpest piece of evidence: to fix it would destroy it. It stands in
`github-release-notes.workflow.json` as shipped. The consequence is stated so no one has to rediscover
it: **that workflow's `since` window is two hours late, it is right by luck, and nothing in the workflow
file itself says so.** Only observations §2.2 does.

---

## 7. Questions this verdict closes without ticketing

#134 raised these and asked whether #135 wanted them. Answered rather than dropped.

- **`--fail`'s exit code is not 22** (observations §3.1). Under HTTP/2 (the default against
  `api.github.com`) a 4xx/5xx surfaces as exit **56** (`CURLE_RECV_ERROR`), not the documented 22. This
  contradicts rubric §4's *background prose*, not any bar, and changes no verdict: the pipeline discarded
  `--fail` for the structural reason in `Q2`. **Recorded as a correction to the standard's background.**
  The rubric is frozen and is not edited. It makes the discarded route *worse* than the rubric described
  (an author who reasons "exit 22 means an HTTP error" would be wrong on the default transport), and it
  means a `binary` step's exit code can vary with a protocol negotiation nothing in the workflow file
  mentions.
- **`have-citations` conflates "nothing to cite" with "the join broke"** (observations §3.5). Real, and
  **not HTTP-specific**: `exists` is simply the only predicate tolerant of an absent path. Not this map's
  business. **No ticket.**
- **`meta` would read better as `response_meta`** (observations §3.5). A naming preference in a dogfood
  workflow. **No ticket.**
- **The `Q4` `per_page=1` probe** stayed quarantined and outside the count, as rubric §4 required. What
  it showed (`%{header_json}` escapes `Link`'s inner quotes and the envelope parses, while raw
  `%header{link}` breaks `parse: "json"`) is a note. **How the pipeline would *accumulate* pages was
  never observed by anything on this map**; `single-page` fails the run instead. That gap is why `Q4` is
  one of the two candidates named in the new trigger.

---

## 8. What would change this verdict

Stated so the next reader does not have to reconstruct it.

- **One more counted contributory `pain`** takes the count to 3. The guard is already satisfied, so any
  counted entry would do it. `Q4` and a harder `Q1b` instance are the live candidates (§5.1).
- **`Q5` turning `pain`** opens the door alone, and two pre-registered defeaters remain live.
  Observations §2.6 record that the structural one was **never tested**: `--config -` and format §4.2's
  input-on-stdin never collided here **only because a `GET` has no request body**. A request that needs
  both a body and a config on stdin would contend for the same single stream, and per rubric §4 that
  blocker would route to the frame rule, not to the door, because a step type would not obviously be the
  fix. The second narrowing is softer but real: `--config -` is a transport, not a guarantee. Nothing in
  v0 steers an author away from `-H "Authorization: Bearer ${config.token}"`, which is shorter, more
  obvious, and what every piece of documentation on the internet shows.
- **An overturn of the collapse ruling** (§3.2) opens the door on the evidence already recorded. It is
  the one ruling here that a reasonable reader could take the other way, which is why the
  counter-argument is written down rather than argued away.
