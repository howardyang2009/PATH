# PATH Delegation Plan — Phase 2: MVP Implementation (issues #15–#26)

A delegation plan in the [AI Fluency](https://anthropic.skilljar.com/ai-fluency-framework-foundations) sense: deciding which work is done by the human, which by AI, and in what interaction mode. This is the build-phase plan that [Phase 1](./delegation-plan.md) promised — scoped to closing the twelve implementation tickets (#15–#26) that turn the [MVP spec](./spec/mvp-spec.md) into a running engine.

Phase 1's prediction holds: this plan **is** much more automation-heavy, because the spec, format doc, and acceptance workflow are now fixed points every ticket can be verified against. All twelve tickets carry `ready-for-agent`; the delegation question is no longer *whether* AI implements them but *where human discernment concentrates* and *which tickets need a human in the loop at all*.

## Problem awareness

The destination is spec §11 verbatim: the release-notes pipeline runs end-to-end on macOS via `path run`, with a complete audit trail, both failure paths demonstrated, and cost accounting on every LLM run. Closing #26 *is* the definition of done. Every other ticket exists only to make #26 closeable; nothing outside the spec's §1 scope should be built (the §10 deferred register stays deferred — scope creep is the main failure mode of an automation-heavy phase).

The dependency graph gives the work order: the chain is linear (#15 → #16 → #17 → #18) until persistence lands, then the frontier widens to #19, #22, #25, with #21 → #23 and #24 hanging off logging, and #26 gated on everything.

## Platform awareness

- **What makes this delegable:** each ticket is a tracer-bullet slice sized for one fresh context window, with acceptance criteria that reference normative documents (spec sections, the format doc) rather than conversation memory. `/implement` drives TDD internally and closes with a two-axis `/code-review` (Standards + Spec) — the Description–Discernment loop is built into the process, per ticket, before anything is committed.
- **Where AI is strong here:** translating the normative format doc into zod schemas and types (#15); mechanical, well-specified subsystems (#17, #18, #22, #23); test-first implementation of precisely stated semantics (most of the board — the spec was grilled specifically so these semantics are unambiguous).
- **Where the risk concentrates:** long-lived interfaces set early (#16's engine skeleton, #19's `LogBackend` seam, #15's public schema API — the future website imports it); adversarial correctness (#20 masking, #24 concurrency/cancellation); and the two tickets AI **cannot fully verify AFK**: #25 (macOS-keychain subscription auth is undocumented SDK behavior that may prompt interactively) and #26 (burns real tokens against a real repo).

## Task delegation

In frontier order. "Automation" = AI implements and verifies, human reads the `/code-review` output and the diff summary. "Automation + focused review" = same, plus a named thing the human must personally inspect. "Human in the loop" = the ticket contains steps only the human can perform or judge.

| Issue | Who leads | Mode | Human discernment focus |
|---|---|---|---|
| #15 `@path/schema` | AI | Automation + focused review | The **exported API surface** — this package outlives the MVP (website imports it); names and types are a long-term commitment |
| #16 Walking skeleton | AI | Automation + focused review | The **engine's module seams** (loader / executor / worker boundary) — every later ticket builds inside this shape |
| #17 Data flow | AI | Automation | Spot-check whole-string typing rule edge cases in the tests |
| #18 Persistence | AI | Automation + focused review | `path runs rm`/`prune` are the only **destructive** commands — verify they cannot delete outside `.path/` |
| #19 Logging | AI | Automation + focused review | The `LogBackend` interface — it is a deliberate door (§10) for remote backends; check nothing engine-side leaks through it |
| #20 Secret masking | AI | Automation + **adversarial review** | Security-sensitive: human personally tries to leak a secret (argv, stderr, trace values, error strings) before accepting |
| #21 Conditions/checkpoint/branch | AI | Automation + focused review | Read a real **trace** with human eyes — it is the audit UX; correctness per schema is not the same as legible |
| #22 Nested workflows | AI | Automation | Context-isolation tests tell the whole story |
| #23 While-do | AI | Automation | — |
| #24 Parallel + cancellation | AI | Automation + **adversarial review** | Concurrency is where tests pass and bugs live anyway: human reviews the failure/cancellation test cases for gaps (races at the join, cancellation during process spawn) |
| #25 LLM worker | **AI + human in the loop** | Augmentation | Human must run the **keychain-auth verification** interactively (undocumented SDK behavior, may prompt), confirm the pinned SDK version, and set a cost expectation for test runs |
| #26 Acceptance | **Human-led**, AI fixes gaps | Augmentation | The human runs the pipeline, pays the tokens, checks all four §11 criteria, and personally signs off — this close *is* the MVP release decision |

### Rationale

- **The board is automation-heavy by design.** Phase 1 spent the human's judgment where it was irreplaceable (scope, semantics, acceptance criteria) precisely so this phase would not need it per-ticket. Re-litigating settled semantics during implementation would waste that investment; the spec wins, and an implementer disagreement is a spec-amendment conversation, not a silent deviation.
- **Focused review beats uniform review.** Reading every diff line of twelve tickets is discernment spread too thin to catch anything. Instead each automation ticket names the *one* thing worth human attention — always either a **long-lived interface** (#15, #16, #19: cheap to fix now, expensive forever after) or a **failure-mode surface** (#18, #20, #24: places where green tests can still hide a bad outcome).
- **#20 and #24 get adversarial review, not just focused review**, because their failure modes are silent. A masking bug leaks secrets into artifacts without failing anything; a join race corrupts context without failing anything. The human's job is to attack, not to read.
- **#25 is the schedule risk — pull it early.** It is unblocked as soon as #18 closes and carries the only *external* uncertainty on the board (pinned SDK, undocumented keychain pickup, real auth). Working it at the front of the wide frontier means a nasty surprise arrives while there is still slack, and the spike findings (`docs/research/agent-sdk-spike-findings.md`) are still fresh. The message-shaped worker contract is the recorded fallback if the keychain caveat bites.
- **#26 is human-led for the same reason #9 was in Phase 1**: it is the yardstick. Letting AI both implement the system and declare its acceptance passed is the discernment trap the framework warns about. AI's role inverts here — the human drives, AI diagnoses and fixes whatever the run surfaces.

## Cross-cutting practices (Description + Diligence)

- **Process description is standardized:** every ticket runs as a fresh-context `/implement` session against the issue — TDD slices, then two-axis `/code-review`, then commit referencing the issue. Context is cleared between tickets; the ticket + spec are the contract, never conversation memory.
- **Performance description:** commits and PRs reference issue numbers; each closing comment states what was verified and how (which tests, which manual checks). That record is what makes the frontier trustworthy — a closed blocker must actually mean *done*, or every downstream ticket inherits the lie.
- **Creation diligence:** the pinned SDK version is a spec decision — no silent upgrades. Anything discovered mid-ticket that wants to widen scope goes to the tracker as a new issue, not into the diff.
- **Transparency diligence:** this codebase is AI-implemented with human review concentrated as the table above describes; this document is the record of that arrangement.
- **Deployment diligence:** the two human sign-offs that cannot be delegated are the #20 secret-leak check and the #26 acceptance close. Everything else may be reviewed at the human's discretion; those two may not be skipped.
