# The engine owns a leaf step's terminal shaping; a worker owns its own verdict

**Status:** accepted; surfaced by the architecture-review deepening that concentrated the leaf-step
terminal shaping into one seam (`settleStepResult`, `packages/engine/src/run-workflow.ts`). Builds on
[ADR 0021](0021-built-ins-are-the-first-two-plugins-and-the-engine-llm-union-is-gone.md) sub-decisions 6
(a worker names no step — the engine prefixes the node name), 7 (the engine owns `cancelled`, derived
from `signal.aborted`, not the worker's report), and 8 (leaf dispatch maps a `StepResult`), and on
[ADR 0020](0020-plugin-masking-is-inherited-and-a-plugin-is-engine-trust.md) sub-decisions 5 (a thrown
exception propagates as an engine fault, never caught into a failed step) and 7 (`stderr` is *returned*
diagnostic text, not a process stream). Records the line that
[#349](https://github.com/howardyang2009/PATH/issues/349) drew in code and
[#328](https://github.com/howardyang2009/PATH/issues/328) pinned in prose, so a later review does not
re-propose moving it.

The CONTEXT.md **Worker** entry already carries the governing sentence: a step type ships one or more
workers "all reaching the same result by a different route … 'same result' is an **author-trust
contract, not an enforced check**." This ADR applies that sentence to one specific temptation — an
engine that second-guesses whether a worker's `succeeded` is *really* success — and answers it, then
records where the engine's own responsibility begins instead.

**Amends** nothing. The `StepResult` seam keeps the two-outcome shape ADR 0021 sub-8 and
[#313](https://github.com/howardyang2009/PATH/issues/313) gave it; this ADR explains why it stays two
and not three, and why the shaping around it is one module rather than several.

## What #349 actually was, and what it was not

The Agent SDK folds some run errors into a **success frame**: an auth failure comes back as
`{ subtype: "success", is_error: true, result: "Failed to authenticate: …" }`. Before #349 the `prompt`
worker read `subtype` alone, returned `{ status: "succeeded", output: <the error text> }`, and the
error rode downstream as a step's product. Only a `parse: "json"` consumer happened to reject it.

The tempting reading is that the *engine* trusted the worker too much and should validate a `succeeded`
result before believing it. That reading is wrong, and acting on it would be a mistake:

- The signal that this "success" was a failure — `is_error` on a `result` frame — is **SDK-specific**.
  A `binary` worker's failure signal is a non-zero exit code; a hypothetical `api-call` worker's is an
  HTTP status. There is no shape an engine-side validator could check across every worker, because
  "what counts as success" is exactly the knowledge a worker exists to hold (CONTEXT, **Worker**).
- The fix that shipped is in the *worker* (`step-plugins/prompt/index.ts`, commit `4f395ec`): it now
  treats `subtype !== "success" || is_error` as failure. That is the right home. The SDK knowledge
  lives with the code that talks to the SDK.

So #349 is not evidence that the seam trusts workers too much. It is evidence that the verdict belongs
to the worker — and that the engine's own, *worker-agnostic* handling of whatever the worker returned
needed a single home and a test surface, which it did not have (the shaping was split across three
functions and reachable only by running a whole pipeline).

## The four pinned sub-decisions

1. **A worker's self-reported `status` is trusted; the engine does not re-judge success.** `StepResult`
   is `{ status: "succeeded" } | { status: "failed" }` and the engine takes it at its word. There is no
   engine-side "does this success look like an error" check, and there is no third `verdict` state on
   the seam for one to hang off. A worker that means "this step failed" returns `failed`; a worker that
   returns `succeeded` is believed. This is the author-trust contract CONTEXT already names, stated at
   the `StepResult` seam.

2. **`cancelled` is the one status the engine overrides, and it is about liveness, not correctness.**
   The engine derives `cancelled` from `request.signal.aborted`, not from anything the worker returned
   (ADR 0021 sub-7): a failing sibling branch or an operator's cancel kills the worker in flight, and
   the engine relabels whatever it returned so no publish from it lands. This is the *only* place an
   engine verdict outranks a worker's, and the reason it is legitimate where a success-check is not:
   "was this step killed" is a fact the engine owns (it holds the signal), while "did this step
   succeed" is a fact only the worker can read.

3. **Everything the engine does with a returned `StepResult` is one seam,** `settleStepResult`. The
   `stderr` capture (rides every outcome — ADR 0020 sub-7), the signal-derived `cancelled` relabel, the
   leaf-only `usage` emit (metering workers only, and before a failed finish too — a step that died
   mid-conversation still spent tokens), the node-name error prefix (ADR 0021 sub-6), and `parse: "json"`
   on a string success (format doc §6.5) are one function, in a fixed order, testable with a fake
   `StepEmitter` and no worker, semaphore, registry, or pipeline. It replaced the split across
   `runLeafStep` (the dispatch), `finishLeafStep` (the parse tail), and `cancelLeafStep` (the kill
   pair), which was the split that let #349 reach production with no seam to pin the mapping's edges.

4. **A thrown exception is still not a verdict.** A worker that *throws* rather than returning `failed`
   is an engine fault (ADR 0020 sub-5): the engine re-throws it, masked, and never folds it into a
   `failed` step, because a crash must not land publishes. `settleStepResult` shapes only a *returned*
   `StepResult`; it never sees a throw. This ADR does not weaken that stance — concentrating the
   returned-result shaping and preserving the throw-propagates rule are the same decision from two
   sides: the engine shapes what a worker *reports*, and treats what it *cannot* report as a bug.

## Considered options

- **An engine-side success validator** — reject a `succeeded` whose `output` "looks like" an error.
  Rejected (sub-decision 1). There is no cross-worker shape to check; #349's signal was `is_error` on an
  SDK frame, meaningless to a `binary` step. Such a validator would either be a no-op or encode one
  worker's tool knowledge into the engine, which is the coupling the plugin seam exists to prevent.
- **A `verdict` hook on the seam** the engine calls to second-guess a result. Rejected. It relocates the
  same un-generalizable judgment to a place the *worker author* must fill anyway, and a forgotten hook
  silently mis-judges — the same failure shape ADR's single-method observer (`run-observer.ts`) was
  built to end. A worker that already returns `succeeded`/`failed` honestly needs no second call.
- **Leave the shaping split** across `runLeafStep`/`finishLeafStep`/`cancelLeafStep`. Rejected
  (sub-decision 3). The raw-result → outcome mapping was testable only end-to-end, which is why #349's
  class of bug had no unit-level guard. One seam gives the mapping's edges — cancelled-outranks-verdict,
  usage-on-a-failed-step, parse-only-on-a-string, stderr-on-every-outcome — a place to be pinned.

## Consequences

- **The `StepResult` seam's contract is unchanged**, and now has a reason on record for staying two
  outcomes with no `verdict` third state: the third state would be worker knowledge the engine cannot
  hold. A future review that proposes an engine success-check or a verdict hook is answered here.
- **`settleStepResult` is exported for its unit test** (`test/settle-step-result.test.ts`), the surface
  that did not exist when #349 shipped. The mapping is now a fact a test asserts, not a path a pipeline
  happens to exercise.
- **A new worker author owns their tool's success judgment.** The seam's job is to return `succeeded`
  or `failed` honestly and to report `usage`/`stderr`; the engine's job is everything downstream of
  that, once, for every worker. CONTEXT's **Worker** and **Secret** entries already say a worker is
  author-trusted code at the level of PATH's own source, so the trust this ADR formalizes is the trust
  that already exists.
- **#349 stays a worker fix, not an engine special case.** Its correction lives in the `prompt` worker,
  beside the SDK it knows; the engine gained no `prompt`-shaped branch. That is the concrete proof of the
  line this ADR draws.
