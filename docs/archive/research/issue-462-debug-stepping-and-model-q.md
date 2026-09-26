# Issue #462 — the debug-stepping spec and Model Q from map #419

**Issue:** #462
**Date:** 2026-09-14

#462 asked for a written report on the debug-stepping spec and ADRs from map #419 (Model Q, the
`paused` status, the Continue route, the bounded-step mechanism), so map #461 (person-activity) could
decide whether `awaiting` shares debug's appendable-tree mechanism or uses a separate one. This report
finds that the artifacts #462 asks to read **do not exist**, that person-activity **already shipped a
separate mechanism**, and that #462's premise is therefore **moot**. It recommends closing #462.

## A. The four questions — the spec/ADRs do not exist

#462 says "read the debug-stepping spec and ADRs produced by map #419" and reports on four things. The
source documents were never produced. This is the finding.

- **No debug spec.** `docs/spec/debug-workflow-spec.md` does not exist (`ls docs/spec/` returns
  `designer-spec.md`, `do-not-wait-join.md`, `mvp-spec.md`, `resume-eligibility-listing.md`,
  `resume-from-k.md`, `server-api-spec.md`, `wait-one-join.md`, `workflow-format-v2-node-semantics.md`,
  and nothing else). `git log --all -- docs/spec/debug-workflow-spec.md` is **empty** — the file was
  never committed on any branch.
- **No debug ADRs.** `docs/adr/` ends at `0037-while-do-iteration-is-a-per-iteration-run-scope.md`. No
  ADR names Model Q, a `paused` status, an appendable tree, a Continue route, or debug-stepping
  (`grep -rli "paused|appendable|debug-step|continue route" docs/adr/` returns nothing).
  `git log --all -S "paused" -- docs/adr/` is **empty**.
- **Model Q appears nowhere.** `grep -rn "Model Q" docs/ CONTEXT.md` returns nothing. The term lives
  only inside the GitHub issue bodies (#419, #421, #425, #461, #465), never in a committed spec or ADR.
- **`paused` is not in the model.** `CONTEXT.md` § Audit and `packages/schema/src/run-status.ts:10`
  list the status enum as `["pending", "running", "awaiting", "succeeded", "failed", "cancelled"]`.
  There is no `paused` status. The one `paused` hit in `docs/spec/designer-spec.md:410` is unrelated
  (it means a browser tab whose reader is idle, in the edit-lease heartbeat text).

Map #419 **is closed** (`COMPLETED`, 2026-09-06), and its decision tickets #421 (paused status +
Model Q ADR), #422 (bounded-step), #423 (Continue route), #424 (Designer surface), #425 (assemble
`debug-workflow-spec.md` + ADRs) are **all closed `COMPLETED`** on 2026-09-06. But the terminal
assembly task #425 produced **no committed artifact**. The decisions were reasoned in the issue
threads; the spec and the Model-Q/paused ADR they were meant to yield were never written into the repo.

So, per question: Model Q (1), the `paused` status spec (2), the Continue route spec (3), and the
bounded-step mechanism (4) are **not specified anywhere in the repo**. They exist only as prose inside
closed GitHub issues. #462 cannot be answered from primary source documents because those documents do
not exist.

## B. Did the debug `paused` mechanism ship? No.

Neither spec nor code. The status enum has no `paused` (`packages/schema/src/run-status.ts:10`). There
is no Continue route: `packages/server/src/routes/` holds `cancel-run.ts`, `complete-run.ts`,
`resume-run.ts`, `post-runs.ts` and others, but **no** `continue-run.ts` or `POST .../continue`
handler. There is no bounded-step engine entry point for a `paused` tree. Debug-stepping is a **closed
map with no shipped output** — and per the current scope decision it will **not** be built in the near
future.

## C. `awaiting` (shipped) vs `paused` (debug) — separate in reality, as they had to be

#461 intended `awaiting` and `paused` to be **distinct statuses** but to **share** the appendable-tree
engine mechanism ("Model Q, shared with debug"; #461 "Settled model" → Engine). The status distinction
holds; the sharing did **not** happen, because debug never produced a mechanism to share.

What actually shipped for person-activity (commit 81ad9c9):

- The worker returns `{ status: "awaiting" }` (`packages/engine/step-plugins/person-activity/index.ts:18`).
- The engine suspends the step on an **in-memory deferred promise** held in a `CompletionRegistry`
  (`packages/engine/src/completion-registry.ts:31-57`; wired at
  `packages/engine/src/run-workflow.ts:588-598`, `settleStepResult` at :631).
- The registries are a `Map<rootRunId, CompletionRegistry>` living in the server process
  (`packages/server/src/live-runs.ts:196`, `:227`).
- Complete is `POST /v0/runs/:step_run_id/complete` (`packages/server/src/routes/complete-run.ts`),
  which calls `ctx.live.complete(...)` (`live-runs.ts:339`) to resolve the in-process deferred.

This is the opposite of Model Q. Model Q (as described in #421) is a **durable, persisted** tree
re-opened by a **fresh engine invocation** with **no held process** — the run survives a restart and is
advanced by re-reading the tree from disk. The shipped `CompletionRegistry` is a **held in-memory
promise**, per-process and **lost on restart**: if the server restarts while a person-activity step is
`awaiting`, the deferred is gone and the run cannot be completed. The gap between what #461 mandated
(shared durable appendable tree) and what shipped (separate in-memory registry) is total — no code is
shared, and the durability property the appendable-tree model exists to provide is absent.

Note the person-activity map has already **re-opened this question on its own side**: open issue #465
("The appendable-tree mechanism for awaiting and its relationship to debug", part of #461) asks whether
to share debug's Model Q or build a separate entry point, and the shipped answer is "separate,
in-memory". Whatever durable-tree design person-activity eventually needs will be produced by #465 and
the other open #461 tickets (#463, #466, #467, #468, #469, #470), **not** by reading debug's
nonexistent spec.

## D. Recommended disposition of #462: close as superseded/deferred

Close #462. Its deliverable cannot be produced and its purpose is moot:

1. **The source it asks to read does not exist.** There is no debug spec and no Model-Q/paused ADR to
   report on (finding A). #462 is a research task with no primary source.
2. **Its consumer already decided without it.** #462 existed to feed #461 the shared-vs-separate
   decision. Person-activity **already shipped** a separate in-memory mechanism (finding C, commit
   81ad9c9). The decision #462 was meant to inform is made and in `main`.
3. **Its subject is deferred.** Debug-stepping will not be built in the near future, so a report on its
   internals has no consumer.

The live remnant — "what durable appendable-tree shape should `awaiting` use" — is **already owned by
open issue #465** under map #461. Nothing needs to be kept open on #462 for it.

### Draft closing comment for #462

> Closing as superseded. #462 asked for a report on the debug-stepping spec and ADRs from map #419
> (Model Q, the `paused` status, the Continue route, the bounded-step mechanism). Those artifacts were
> never produced: there is no `docs/spec/debug-workflow-spec.md` (nothing on any branch in git), no ADR
> for Model Q / `paused` / Continue / bounded-step (`docs/adr/` ends at 0037), and no `paused` status
> in the enum (`packages/schema/src/run-status.ts` is `pending|running|awaiting|succeeded|failed|
> cancelled`). Map #419 and its tickets #421–#425 closed as completed in the issue threads, but the
> terminal assembly ticket #425 committed no spec or ADR. "Model Q" appears only inside issue bodies.
>
> The reason #462 existed — to tell map #461 whether `awaiting` should share debug's appendable-tree
> mechanism — is moot. Person-activity already shipped (81ad9c9) with its own **separate, in-memory**
> `CompletionRegistry` (a held deferred promise per run tree, lost on restart), not the durable
> appendable tree. Debug-stepping is also deferred indefinitely. The remaining live question — the
> durable appendable-tree shape that `awaiting` should eventually use — is already owned by #465 under
> map #461, which does not depend on debug's (nonexistent) spec.
>
> Full write-up: `docs/research/issue-462-debug-stepping-and-model-q.md`.

## Sources

- Issues: #419 (closed), #421/#422/#423/#424/#425 (closed `COMPLETED`, 2026-09-06), #461 (open),
  #462 (open), #465 (open), via `gh issue view --repo howardyang2009/PATH`.
- `CONTEXT.md` § Core execution model, § Audit, § Resume, § Surfaces.
- `packages/schema/src/run-status.ts:10`.
- `packages/engine/step-plugins/person-activity/index.ts:18`.
- `packages/engine/src/completion-registry.ts:31-57`.
- `packages/engine/src/run-workflow.ts:103-107, 545-546, 588-598, 631`.
- `packages/server/src/live-runs.ts:196, 227, 339-341`.
- `packages/server/src/routes/complete-run.ts`; `ls packages/server/src/routes/` (no continue route).
- `ls docs/spec/`, `ls docs/adr/`, `git log --all -- docs/spec/debug-workflow-spec.md` (empty),
  `git log --all -S "paused" -- docs/adr/` (empty), `grep -rn "Model Q" docs/ CONTEXT.md` (empty).
