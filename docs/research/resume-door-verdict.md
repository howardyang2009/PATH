# Resume door — the verdict

The weighing of [#144](https://github.com/howardyang2009/PATH/issues/144)'s observations
([resume-door-observations.md](resume-door-observations.md)) against the bar fixed in
[#143](https://github.com/howardyang2009/PATH/issues/143) ([resume-door-bar.md](resume-door-bar.md)),
under the semantics [#145](https://github.com/howardyang2009/PATH/issues/145)–[#149](https://github.com/howardyang2009/PATH/issues/149)
settled. Resolves [#150](https://github.com/howardyang2009/PATH/issues/150) and reaches the
destination of [map #142](https://github.com/howardyang2009/PATH/issues/142).

**Date:** 2026-08-04.

---

## 1. The verdict

**The door opens.** The `Retry / resume` door in [#109](https://github.com/howardyang2009/PATH/issues/109)
is promoted — outcome 1 of the three [#142](https://github.com/howardyang2009/PATH/issues/142) made
available. §1 stops ruling resume out, §5.6 and §10 are rewritten to point at the settled semantics
(§3 below), and the next map's destination is named (§6): the CLI/format/engine surface.

Kill C — the bar's judged kill (forced, second `^C`, inside the second `while-do` iteration) —
returned a residual of **89.5% of total run spend**, well above resume-door-bar.md §5's 50% floor.
That number depends entirely on one ruling, stated in the open because the verdict turns on it:
whether the "seed shim" resume-door-observations.md §3–4 used to recover 100% of both kills' spend
is legal salvage under the bar's §3 line. **It is not.** §2 states the ruling and why.

---

## 2. The tally

resume-door-bar.md §5's outcome table is applied to Kill C, the bar's judged kill.

| Quantity | Value |
| --- | --- |
| Total run spend (denominator, §144's reference run) | $1.0207468 |
| Gross re-burn at Kill C (sum of succeeded runs when the kill landed) | $0.9139146 |
| Salvage recovered, **as demonstrated** using only in-bar §3 surfaces | $0 (§2 below) |
| **Residual** | **$0.9139146** |
| **Residual ÷ total run spend** | **≈ 89.5%** |

Per resume-door-bar.md §5: **≥ 50% → the door opens.** Kill C clears the floor by a wide margin
either way the crux ruling goes — even crediting the seed-shim's full recovery would have landed at
0%, the opposite pole. There is no middle-band ambiguity here; the ruling below decides *which* pole,
not whether the door clears a threshold near the line.

---

## 3. The crux ruling: the seed shim is not in-bar salvage

resume-door-observations.md §3–4 recovered **100%** of both Kill B's and Kill C's gross re-burn,
reducing each kill's own naive residual to $0. It did this with a four-node workflow file — a
"seed shim" — authored for this ticket: three `binary` `cat`-passthrough nodes moving
`${config.draft}` / `${config.feedback}` / `${config.raw_changes}` into context, then a `workflow`
step `ref`-ing the unmodified `revise-cycle.workflow.json`. resume-door-observations.md §5 flagged
the shim's standing under resume-door-bar.md §3 as unresolved and left it to this ticket, rather than
asserting it either way — the ruling below is that assignment, discharged.

**resume-door-bar.md §3 allows "running a nested workflow file directly."** It does not say
"authoring a new workflow file that wraps one." resume-door-observations.md §3 itself found that
running `revise-cycle.workflow.json` **bare, unmodified** — the thing §3 actually names — recovers
**nothing**: a root-level `path run` has no documented way to seed a file's starting `context`, only
its `config` (`cli.ts`'s `RUN_USAGE` offers `--config`/`--set` alone, which land in `config`, not
`context` — `run-workflow.ts:241`, `cli.ts:207–268`). The shim's first three nodes exist for no
purpose other than routing around that gap. That is engineering a workaround for a missing CLI
affordance, not exercising a documented one — precisely the category resume-door-bar.md §3's closing
line was written to keep out: *"the line is drawn at documented rather than possible on purpose...
a possibility-based standard would shut the door by a test no real operator meets."* The shim is
possible — it is built entirely from public `path/workflow@0` mechanics, no internals, no forbidden
surface (§3's explicit bans: no blob edits, no `path.db`, no engine patch, all honored) — but
*possible with public mechanics* is not the bar's test. The bar's test is *documented, already there*,
and "run this file directly" was never documented as "author a second file that makes the first one
runnable."

**What this means for the numbers.** With the shim excluded, the only §3-legal salvage attempt on
record is "run `revise-cycle.workflow.json` directly" — performed, and it recovered $0
(resume-door-observations.md §3, first paragraph under "Salvage"). Residual therefore equals gross
re-burn at both kills. Kill C, the judged one: $0.9139146 residual, ≈89.5% of total run spend.

**Recorded finding, not the door's to fix:** the gap the shim closes is real. Root-level `path run`
genuinely has no documented way to seed a file's starting context, so "running a nested workflow file
directly" is a **narrower affordance than resume-door-bar.md §3 assumed it was** when it named that
surface as recoverable. That is a fact about today's CLI, independent of this verdict, and belongs
wherever the next map decides `path run --resume`'s input-seeding story lands (§6) — not smuggled
into this door's economics by crediting a salvage method the bar never authorized.

---

## 4. What the record now says

### 4.1 mvp-spec §1 — the out-of-scope bullet moves out

The current bullet:

> Run retry, and resume of crash-interrupted runs — MVP failure behavior is fail-fast only (§5.6).
> Fail-fast is about *failure*: an operator stopping a run is not a failure, and a root run **is**
> cancellable. What a stop owes is truth about where the run got to, not the ability to resume it.

is removed from the **Out of scope** list — it is no longer accurate to call resume out of scope once
its semantics are decided and a map exists to build its surface. A resumed run **is not itself
retried automatically**; that half of the old bullet stays true and stays out of scope (§4.4). The
`owes truth` sentence is not deleted — it is relocated, unedited, into a new paragraph (§4.2) where it
becomes a precondition rather than a closing remark.

### 4.2 mvp-spec §5.6 — the fail-fast paragraph, and the truth sentence

"Retry and resume are out of scope (§1)" is replaced with a pointer: resume's semantics are settled
(this document; [resume-reuse-semantics.md](resume-reuse-semantics.md),
[resume-invalidation-semantics.md](resume-invalidation-semantics.md),
[resume-side-effect-contract.md](resume-side-effect-contract.md),
[resume-restore-semantics.md](resume-restore-semantics.md),
[resume-run-identity.md](resume-run-identity.md)); the CLI/format/engine surface is
[the next map](#6-the-next-map)'s. Automatic in-run retry (backoff, `drain-then-fail`,
`tolerate-failures`, per-branch `on-failure`) stays explicitly out of scope, unchanged.

**The `owes truth` sentence — survives.** *"What a stop owes is truth about where the run got to,
not the ability to resume it"* is not amended and not retired. Its claim — a stop's only obligation
is an accurate status — is untouched by resume opening: nothing about resume asks a stop to do
anything differently, and `cancelled` and `failed` rows mean exactly what they meant before. What
changes is the sentence's *weight*: cause-blind resume ([map #142](https://github.com/howardyang2009/PATH/issues/142)'s
locked rule) reruns any run whose status is not `succeeded`, gated on nothing but that status
([resume-invalidation-semantics.md](resume-invalidation-semantics.md), `(node id, status)` alone). A
resume that trusts recorded status without re-verifying it depends on that status having been
recorded truthfully in the first place — the sentence stops being a closing remark about a feature
that doesn't exist and becomes the precondition resume's entire reuse mechanism leans on. A
cross-reference to this document is added next to it in the spec text; the sentence's own words do
not change.

### 4.3 mvp-spec §5.7 — cross-tree SUM, an explicit amendment

§5.7 states subtree/whole-run cost as a read-time SUM over descendant run rows, "so ground truth
exists exactly once." [resume-restore-semantics.md §5](resume-restore-semantics.md) found this
breaks under the successor-run identity model ([resume-run-identity.md](resume-run-identity.md),
[ADR 0001](../adr/0001-resumed-run-is-a-successor-run.md)): a reused node's usage/cost row lives only
in the *original* tree, so a naive SUM over a resumed tree's own descendants silently undercounts
every reused LLM run. §5.7 gains a sentence: for a successor run, the SUM traverses the reuse-marker
link into the original tree for every reused node, rather than duplicating rows into the new tree
(which would create two ground truths for the same spend — the exact failure the "exactly once" rule
exists to prevent). The reuse-marker's exact field shape is next-map surface design (§6); this
amendment fixes only that the SUM must cross tree boundaries, not how.

### 4.4 mvp-spec §10 — the register row

The row —

> `Retry/resume` \| write-through `context.json` + truthful crash snapshots

— stays (this door is not shipped, unlike `$env`'s retired row) and is rewritten:

> `Retry/resume` \| Semantics settled — map [#142](https://github.com/howardyang2009/PATH/issues/142),
> verdict [resume-door-verdict.md](resume-door-verdict.md). Automatic in-run retry (backoff,
> per-branch `on-failure`) stays out of scope; "resume" is one operator verb, cause-blind. CLI /
> format / engine surface tracked at [the next map](#6-the-next-map).

### 4.5 [#109](https://github.com/howardyang2009/PATH/issues/109) — the tracking issue

The `Retry / resume` entry's checkbox ticks — matching the API-endpoint entry's precedent, where a
reached verdict ticks the box independent of whether code ships from it. Its body is rewritten to
state the outcome (§1 above) in place of "map charted," with the same evidence-links footer style
the API-endpoint entry uses.

---

## 5. What this verdict does not own

Recorded and pointed at, per resume-door-bar.md §6 and [#142](https://github.com/howardyang2009/PATH/issues/142)'s
own "not yet specified" list — none of these are decided here.

- **Automatic in-run retry.** A failure policy in §5.6's rejected family (`drain-then-fail`,
  `tolerate-failures`, per-branch `on-failure`). Stays out of scope; if still wanted, it earns its own
  register row and its own trigger, separate from this one (#109's existing "this row splits"
  language, unchanged).
- **The force path (second `^C`).** resume-door-bar.md §6 asked whether the clean-vs-forced delta
  (Kill B vs. Kill C) shows the forced path uniquely losing something the clean path keeps, which
  would reopen §5.6's "the forced exit is the one exception, and it is accepted" trade.
  resume-door-observations.md §5 answers this: the *only* delta is the lying `running` rows, which
  §1 below already assigns elsewhere. The salvage procedure itself — reading the killed leaf's
  `input.json` — needed nothing from either kill's unwind state; it started an independent new run
  from a recovered blob. **The force path does not need to change.** Closed here rather than left
  dangling, since the evidence to close it already exists.
- **The lying `running` rows / a reconcile pass.** resume-door-bar.md §1: fixable by a startup pass
  marking abandoned rows crashed, with no resume semantics — this door does not own it, and opening
  this door does not make that fix less worth having on its own: a `running` row still lies forever
  to an operator who does not choose to resume it. Whether it becomes its own register row is a call
  for whoever reads this next, not made here.
- **Retention becoming load-bearing.** [resume-run-identity.md §4](resume-run-identity.md) settled
  the narrow case — `path runs rm` blocks by default against a live reuse-marker back-reference — but
  the broader question (`.path/runs/` "keep everything, no automatic expiry" as convenience vs. as a
  correctness precondition once resume reads recorded outputs back) is [#142](https://github.com/howardyang2009/PATH/issues/142)'s
  own "not yet specified" item, untouched here.
- **The server and viewer's view of a resumed tree.** `GET /v0/runs` and any UI over it currently
  describe one run tree per root run; a successor run changes that shape. Named, not designed, in
  §6.

---

## 6. The next map

**Wayfinder map: the resume surface** — filed as [#158](https://github.com/howardyang2009/PATH/issues/158),
chartering the CLI flag, format field(s), and engine plumbing for the semantics
[#145](https://github.com/howardyang2009/PATH/issues/145)–[#149](https://github.com/howardyang2009/PATH/issues/149)
already settled and this verdict promotes. Its destination is code, unlike this map's — the first
register door whose graduation is an engine, not a decision.

---

## 7. Recorded, not weighed

- **Wall-clock re-burn**, the clean-vs-forced mechanism delta, and the lying `running` rows —
  resume-door-observations.md §5 already recorded these against resume-door-bar.md §6; nothing here
  adds weight to them beyond §5 above's disposition of the force-path question they raised.
- **The seed shim itself remains a useful artifact**, even though it does not count as bar-legal
  salvage: it is a concrete, working demonstration of context-seeding-by-workaround that the next map
  can treat as a spike for "does `path run --resume` need a documented context-seed path" (§6)
  — recorded as engineering input, not economic evidence.
