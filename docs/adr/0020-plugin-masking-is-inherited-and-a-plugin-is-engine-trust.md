# A plugin inherits masking at the emit choke point, and a plugin is engine-level trust

**Status:** accepted; the secret-masking and trust decision of map
[#308](https://github.com/howardyang2009/PATH/issues/308), resolving
[#316](https://github.com/howardyang2009/PATH/issues/316). Builds on the
[#313](https://github.com/howardyang2009/PATH/issues/313) resolution (the `run` seam and one-lookup
dispatch) and [ADR 0019](0019-step-plugins-are-folders-under-packages-engine-step-plugins.md) (plugins
are folders, `binary` and `prompt` among them).

**Tightens** the #313 resolution's sub-decision 10 (a thrown exception propagates). #316 was the one
ticket permitted to tighten that stance and forbidden to loosen it; sub-decision 5 below is the
tightening. #313 sub-10 lives in a GitHub resolution comment, not in an ADR file, so there is nothing to
amend in place.

**Amends no ADR.** It adds a cross-reference line to
[ADR 0012](0012-operator-config-rejects-env-wrapper.md), whose decision stands unchanged
(sub-decision 12).

PATH masks secrets at a **single choke point**: the engine's emit of an **Observation**. Workers
deliberately receive **real**, unmasked values, because masking is an audit-surface concern and not a
dataflow restriction (CONTEXT.md, *Secret*). Locked decision 3 of #308 makes a plugin's worker
**in-process TypeScript** loaded into the engine, with no sandbox. ADR 0019 sub-decision 10 then made
`binary` and `prompt` plugins themselves, so this is no longer a question about third-party code alone.

Two questions follow, and this ADR answers both. Does the masking invariant still hold when the code
holding real secrets is inside the engine process rather than behind a child-process boundary? And what,
exactly, is a plugin author trusted with?

Decision: **a plugin's returned values are masked because they are engine-composed observations, and a
plugin introduces no new audit surface on that path. What in-process code can do *around* that path —
write a process stream, mint a new secret value, touch the filesystem — is a stated limit, not a hole to
plug, because a plugin is engine code and carries the trust of PATH's own source.**

## The twelve pinned sub-decisions

### Masking

1. **The return path is masked by construction, not by promise.** A `StepResult`'s `output`, `error`,
   `usage` and `stderr` reach disk only as observations — `step-finished`, `step-usage`, `step-stderr` —
   and `maskObservation` is **total over that union by its `never` guard**
   (`packages/engine/src/secret-mask.ts`). A worker emits nothing and holds no audit handle (#313
   sub-5). So there is no plugin-specific routing to write and none to forget: every path from a plugin
   to disk crosses the one choke point that CONTEXT requires no observer or wrapper be partial about.
   `estimatedCostUsd` is a number and needs no masking. The masker already treats `usage` as a payload
   the engine "neither built nor validated"; under this ADR `output` joins it, and the by-value
   design means that costs nothing.

2. **`$secret` and `$env` wrappers are representable in config only.** `collectSecrets` walks **config
   objects** and nothing else. A plugin declares its own zod field fragment (ADR 0018), so a fragment
   accepting a wrapper shape would carry a real secret the masker never collected, straight into a
   `step-started` `input`. A plugin's fields therefore may not accept a wrapper; a field reaches a
   secret exclusively by interpolating `{{config.key}}`, which is already collected. The rejected
   alternative — widen `collectSecrets` to walk fields too — adds a second walk that can drift from the
   first, which is the exact failure `maskObservation`'s hand-written predecessor demonstrated (6 of 14
   hooks implemented, the other 8 silent no-ops). This is a constraint handed to
   [#320](https://github.com/howardyang2009/PATH/issues/320), which owns the config-versus-field line.

3. **A value the plugin mints at runtime is a documented limit.** An `api-call` plugin that exchanges a
   `$secret` client secret for a bearer token holds a value the masker never saw; if it reaches `output`
   it is persisted in the clear. This is the same class as CONTEXT's existing transformed-secret limit
   ("a transformed secret escapes string matching — accepted, no taint tracking"), not a new one. No
   worker-side `maskAlso(value)` handle: that is an audit handle in plugin hands, which #313 sub-5
   rejected on the ground that CONTEXT requires one choke point no caller can be partial about — and a
   plugin that can mint a value can equally print it, so the handle would buy a promise it cannot keep.

4. **What a plugin writes to a process stream is outside the audit surface.** This is the one surface
   that is genuinely new, and it is new precisely because in-process differs from `binary`. A `binary`
   step's child streams are captured — stdout is the output, stderr is the audit blob. An in-process
   plugin calling `console.log` writes to the **engine process's own stdout**: the CLI's terminal, and
   under CI a retained build log. It is uncaptured and unmasked. The positive rule that replaces it: **a
   worker reports diagnostics by returning `stderr` on its `StepResult`, never by writing to a process
   stream.** Interception was rejected — patching `console` for the duration of a `run` call cannot
   cover `process.stdout.write`, a stream reference a transitively imported library captured at import
   time, a native module, or a child the plugin spawns with inherited stdio. Partial capture reads like
   coverage and is not; a stated limit plus one sanctioned channel is honest.

5. **A thrown exception propagates, and its message is masked on the way out.** #313 sub-10 stands: the
   engine does not catch a throw into a `failed` step, because a plugin that means "this step failed"
   returns `failed`, and catching would let a crash land publishes. The tightening: `runWorkflow` applies
   the run's masker to the message and re-throws with the error's class and stack preserved. This closes
   the config-secret case that sub-10's own reasoning misidentified — a config secret in a thrown message
   *is* in the collected set and always was maskable — and leaves the sub-decision 3 case honestly open.
   CONTEXT's "a thrown *bug* escapes masking entirely" narrows accordingly: the throw still escapes the
   *failed-run* contract, but no longer escapes the masker.

6. **The masked re-throw lives in `runWorkflow`, not in each caller.** The masker is run-scoped and
   already sits there, at the boundary that masks `RunResult` (`run-workflow.ts`, the `#123` surface).
   One placement covers the CLI's stderr and the server at once — and the server matters, because a
   thrown message could otherwise reach an HTTP response body read by the browser operator of
   sub-decision 9. Per-caller placement repeats the predicate and lets one caller forget.

7. **The seam field stays named `stderr`.** Sub-decision 4 makes it load-bearing — it is now the only
   sanctioned diagnostic channel — and an author may reasonably read the name as the process stream the
   rule forbids. It is kept anyway: it names the audit blob it lands in (`stderr.txt`) and the
   observation it becomes (`step-stderr`), and a rename to `diagnostics` would fork the seam field from
   both. The doc comment carries the correction instead: the field is *captured diagnostic text*, and for
   `binary` that text happens to be a child's stderr.

### Trust

8. **A plugin is engine code, and carries the trust of PATH's own source.** Not "equivalent to the
   `binary` step's command" — strictly above it. A `binary` command is a child process, named in the
   workflow file where a reader of that file can see it, holding only the config that step was given. A
   plugin runs **in the engine's process**: it can reach every secret in the whole run tree and not only
   its own, plus the store handle, the observer, and the run's heap. It is not named in any workflow
   file — only its type is. ADR 0019 sub-10 settles the matter physically: `binary` and `prompt` are
   folders under `packages/engine/step-plugins/`, tracked in git, loaded by the same path as any other
   plugin. **Adding a plugin is editing the engine.** The trust boundary is therefore write access to the
   PATH tree, which is source-code write access, and nothing in this ADR defends against a hostile
   plugin. Sandboxing untrusted plugin code stays out of scope (#308).

9. **The engine's `$env` resolution is the only env door.** A worker must not read `process.env`, and a
   plugin must not declare a field that names an environment variable. ADR 0012 rejects
   `{"$env": "NAME"}` in operator config at the value layer, because a **browser operator** launches only
   *discovered* workflows and cannot author a step, so `$env` on the override path would hand that
   operator an env-read power they do not otherwise hold. Sub-decision 8 moves the boundary ADR 0012
   named: in-process code can call `process.env` directly, and a field like `{"tokenFromEnv":
   "AWS_SECRET_KEY"}` interpolated from operator config routes around the value-layer check entirely —
   no wrapper ever appears. ADR 0012 pre-committed to reopen "if that boundary ever moves". This is the
   reopening, and the answer is a rule rather than a mechanism: stripping `process.env` for the duration
   of a `run` call fails for sub-decision 4's reasons. What enforces it is code review of the PATH tree,
   which is what sub-decision 8 made the boundary.

### Record

10. **One acceptance test is part of this decision, not a follow-up.** Sub-decision 1's invariant is
    structural but not self-proving: the `never` guard protects the *union*, and nothing protects the
    claim that a plugin's `output`, `usage` and `stderr` actually reach it. `test/mask-observation.test.ts`
    already carries a sample per member for exactly this reason — "totality is not the same as coverage".
    So: one acceptance test with a fixture plugin returning a declared secret in all three channels,
    mirroring `test/acceptance/env-secret.test.ts`. One test, not a suite.

11. **CONTEXT.md amends *Secret* and *Worker*, and gains no new term.** *Secret* records that a worker is
    in-process, and carries the two documented limits of sub-decisions 3 and 4. *Worker* records the
    trust level of sub-decision 8 and the diagnostic rule of sub-decision 4. *Observation* is left alone:
    #313 sub-5 is a fact about the seam, not a change to what an observation is, and CONTEXT is a
    glossary. "Audit surface" is already used inside the *Secret* entry and does not earn a definition.

12. **ADR 0012 gets a cross-reference line, not an amendment.** Its decision stands exactly as written:
    the `$env` reject is unchanged and sub-decision 9 adds a rule that keeps it true under a new
    condition. But 0012 wrote its own pre-commitment to reopen, so a reader who lands on 0012 alone must
    learn that the boundary moved and where the answer went. One line. Everything else this ADR touches
    is cited, not amended.

## Considered options

- **Route a plugin's outputs through the masker explicitly, as a new audit surface.** Rejected: it is
  already true by construction (sub-decision 1), and writing plugin-specific masking code would create
  the second, driftable path that sub-decision 2 rejects on the same grounds.
- **Give the worker a `maskAlso(value)` handle for minted secrets.** Rejected in sub-decision 3.
  Contradicts #313 sub-5 and CONTEXT's one-choke-point rule, and cannot bind a plugin that prints.
- **Intercept `console` / `process.stdout` around a `run` call.** Rejected in sub-decision 4. Cannot be
  total; partial masking is worse than a stated limit because it reads as coverage.
- **Catch a plugin's throw and convert it to a `failed` step.** Rejected outright — it contradicts #313
  sub-10, which #316 could tighten and not loosen, and a crash converted to a failure lands publishes.
- **Strip `process.env` for the duration of a `run` call.** Rejected in sub-decision 9, for
  sub-decision 4's reason: process-global, defeated by any reference captured at import time.
- **State plugin trust as equivalent to the `binary` command's.** Rejected in sub-decision 8: it
  understates the privilege, and ADR 0019 sub-10 already makes the built-ins plugins.
- **Land this as amendments to ADR 0019 plus CONTEXT edits, as #315 did.** Rejected: sub-decision 5
  tightens a locked sub-decision and sub-decision 9 re-closes a security decision recorded in a
  different ADR. Neither is a fact about the folder contract, which is 0019's subject, and both need a
  record a future reader can find.

## Consequences

- **[#319](https://github.com/howardyang2009/PATH/issues/319) is gated by this ADR twice.** Its move of
  `binary-worker.ts` and `agent-sdk-worker.ts` into plugin folders is exactly when a masking regression
  can land silently, so sub-decision 10's acceptance test must pass **against the relocated built-ins**
  before #319 lands; it exists to survive that move. And the relocated workers must themselves obey
  sub-decisions 4 and 9 — no process-stream writes, no `process.env` reads. `binary` spawning a child is
  fine; `binary`'s own code reading `process.env` is not. This is the dogfood ADR 0019 sub-10 promised:
  if PATH's own two step types cannot obey the plugin rules, the rules are wrong.
- **[#320](https://github.com/howardyang2009/PATH/issues/320) receives two constraints**, the way #315
  handed one to #324. Wrappers are config-only (sub-decision 2), and no field may name an environment
  variable (sub-decision 9). #320 therefore does not open with "may a field carry a secret" — that is
  answered — but with which keys a plugin declares as config in the first place.
- **A plugin author has one diagnostic channel and one env door.** Both are rules with no mechanism
  behind them. That is deliberate and it is the honest reading of locked decision 3: in-process code
  cannot be constrained by the engine that loads it, only by the review that admits it.
- **CONTEXT.md's *Secret* entry gains two limits and loses one absolute.** "A thrown bug escapes masking
  entirely" becomes narrower under sub-decision 5.
- **Nothing here defends against a hostile plugin, and the ADR says so.** A future sandboxing effort is
  its own map (#308, out of scope). This ADR fixes what is true without one.
