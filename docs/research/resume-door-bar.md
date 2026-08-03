# Resume door — the pre-registered bar

The standard by which [map #142](https://github.com/howardyang2009/PATH/issues/142) judges whether the **resume** door in the [v-next register](https://github.com/howardyang2009/PATH/issues/109) opens, fixed in [#143](https://github.com/howardyang2009/PATH/issues/143) **before the kill-run produces a number**.

**This file is frozen.** It is committed before [#144](https://github.com/howardyang2009/PATH/issues/144) kills anything, so the freeze is verifiable from git history rather than asserted. #144 records its measurements in a **separate** file; it does not edit this one. [#150](https://github.com/howardyang2009/PATH/issues/150) applies §5's outcome table to what #144 wrote.

If something here turns out to be unmeasurable, the correction goes in #144's file as a stated fault in this standard (§7), not as an edit here. A bar the person holding the number can move is not a bar.

Why a bar at all: the thing being measured is a **dollar figure**, and the question it decides is whether to redraw [mvp-spec](../spec/mvp-spec.md) §1's out-of-scope line. Choosing the threshold after seeing the figure is the failure mode pre-registration exists to remove. Same discipline as the API door's [rubric](api-door-rubric.md) (#130), which is what let [#135](https://github.com/howardyang2009/PATH/issues/135)'s verdict stand when it came back against the door.

## 1. One opener, and it is economic

**The only thing that opens this door is unrecoverable spend.**

The register holds this door at "write-through `context.json` + truthful crash snapshots", and §1's own wording is "resume of crash-interrupted runs". That invites a second, tempting route: §5.6 admits the CLI's second `^C` abandons the unwind, leaving rows that say `running` forever, and states outright that "nothing reconciles such rows afterwards — resume of interrupted runs is out of scope (§1)". It reads like a problem only resume can fix.

It is not. A lying `running` row is fixable by a reconcile pass that marks abandoned rows crashed at next startup — no resume semantics, no reuse of recorded outputs, no redrawn scope line. Letting a record-truthfulness problem open a door that a much cheaper feature closes is precisely how a register row rots into a foregone conclusion.

So the truthfulness problem is **recorded as a finding and cannot open this door** (§6). This follows #135's ruling on its own scoped-env finding: a map records what it found and points at where it belongs, rather than annexing it.

## 2. What is measured

Three quantities, at each kill point in §4.

### Gross re-burn

The spend a from-scratch rerun repeats: the sum of `estimatedCostUsd`, and of `usage` token counts, over **every run that had already succeeded when the kill landed**.

Mechanical, and already recorded — `usage` is the worker's real token counts and `estimatedCostUsd` comes from the Agent SDK's `total_cost_usd`, both populated leaf-only on prompt-step runs (`packages/schema/src/run-record.ts`, `packages/engine/src/llm/agent-sdk-worker.ts`). No estimation, no modelling.

### Residual

Gross re-burn **minus what a demonstrated manual salvage actually recovered** (§3).

This is the number the bar judges, and the distinction is the whole point. Spend that a naive rerun repeats is not the same as spend an operator cannot get back today. Everything the operator can already recover, resume does not buy — crediting it to the door would open the door on a pain the product does not have.

### Denominator — total run spend

The total spend of a **complete reference run** of the same pipeline over the same `commit_range`, run before the kills.

#144 owes this baseline first. Without it there is no fraction, and an absolute dollar figure on a pipeline this size would decide the question by toy scale rather than by substance. Stating the bar as a fraction is what makes it scale-invariant, so no extrapolation from this pipeline to an imagined larger one is needed — or permitted.

## 3. The salvage attempt, and what it may use

After each kill, #144 **attempts the hand-restart** and records what it recovered and what it cost. A salvage that is asserted rather than performed does not count.

**Allowed** — documented surfaces only:

- `path run` with fresh `--config` / `--set`.
- Running a nested workflow file directly (`revise-cycle.workflow.json` is a workflow in its own right).
- Reading blobs under `.path/runs/<root-run-id>/`. §5.7 promises every blob is a JSON file, "no size-threshold inlining: one rule, every object cat-able on disk" — reading them is a documented affordance, not a trick.
- Reading `run.log` and `path runs` output.

**Forbidden:**

- Hand-editing any blob, including `context.json`.
- Reading or writing `path.db` directly.
- Patching or instrumenting engine code.
- Anything that requires knowing an internal the spec does not document.

The line is drawn at *documented* rather than *possible* on purpose. Nothing is unrecoverable when hand-editing JSON is allowed, so a possibility-based standard would shut the door by a test no real operator meets — and would be just as dishonest as no standard at all.

**Effort is recorded even when the salvage succeeds**: wall-clock, and the count of manual actions taken. A salvage costing twenty minutes and nine steps recovers the money and still says something, but it says it in §6, not in the bar.

## 4. Kill points, named in advance

Fixed here so the measurement cannot be shopped for a depth that produces the wanted number.

The target is the acceptance pipeline — [`release-notes.workflow.json`](../acceptance-workflow/release-notes.workflow.json) plus [`revise-cycle.workflow.json`](../acceptance-workflow/revise-cycle.workflow.json), §11's acceptance case. Its shape puts the money in the tail: one `binary` `git log`, a checkpoint, two short parallel `prompt` summaries, then `draft-notes`, `judge-draft`, and a `while-do` running the nested `revise` workflow (two prompts per iteration) up to `max_revisions`.

| Kill | Where | Mode |
| --- | --- | --- |
| **A** | inside the parallel `summarize` block | clean cancel |
| **B** | inside the `revise` prompt of the **second** `while-do` iteration | clean cancel |
| **C** | the same node as B | **forced** — second `^C` |

**The bar judges C.** It is the worst honest case, and the one §5.6 admits it handles badly.

B against C isolates what the force path uniquely loses — a difference that matters, because if the loss is concentrated there it has a much cheaper fix than resume, and the verdict must say so. A against B shows how the residual scales with depth, which is what makes the verdict readable rather than a bare number.

## 5. Outcome table

Applied to **kill C**, residual over total run spend.

| Residual ÷ total run spend | Outcome |
| --- | --- |
| **≥ 50%** | The door **opens**. §1 stops ruling resume out, §5.6 and §10 are rewritten to match, and #150 names the next map's destination. |
| **10% – 50%** | **Re-park** with a sharper trigger — one that is fireable and has not already fired. |
| **< 10%**, *and* the §3 salvage recovered the rest | The row **retires**. §1's bullet stops being provisional and §10's row goes. |

Half a run's money gone with no operator path back is a claim strong enough to redraw a scope line; less than that is a claim about inconvenience, and inconvenience does not redraw §1.

The floor exists because [#109](https://github.com/howardyang2009/PATH/issues/109) was created to stop deferred rows rotting, and a standard that can only choose between "open" and "re-park" guarantees this row outlives every measurement ever taken against it. A door that cannot be closed is not a door.

The middle band re-parks rather than retires because a mid-range residual says the pain is real but not yet decisive — the same verdict shape #135 reached for the API door.

## 6. Recorded, but outside the bar

These are written down by #144 and weighed in prose by #150. **None of them moves the threshold in §5.**

- **Wall-clock re-burn.** LLM runs are slow and an operator waiting through them again is paying something. It is not in the bar because money is the scarce thing here and wall-clock largely tracks it; recording it separately keeps that assumption checkable.
- **The clean-versus-forced delta** (B against C). If the force path is uniquely lossy, that is a finding about §5.6's escape hatch, not about resume.
- **The lying `running` rows.** Per §1, a finding this door does not own. Recorded with the reconcile-pass counterargument stated alongside it, so a later reader does not have to reconstruct why it was excluded.
- **Anything the kills expose that belongs to another door** — retention becoming load-bearing, the fresh-processor contract, the server's view of an interrupted run. Recorded and pointed at, never annexed.

## 7. If this standard is wrong

If a quantity in §2 cannot actually be measured — `estimatedCostUsd` absent on the runs that matter, no complete reference run obtainable, a kill that cannot be landed on the named node — #144 records that as a **fault in this bar**, naming which part failed and why, and #150 weighs the evidence knowing the standard had a hole. It does not silently substitute a different measurement, and it does not edit this file.

A hole in the standard is information about the standard. Patching it after the fact destroys exactly the thing the freeze was for.
