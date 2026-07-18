# PATH Delegation Plan — Phase 1: MVP Spec (wayfinder map #1)

A delegation plan in the [AI Fluency](https://anthropic.skilljar.com/ai-fluency-framework-foundations) sense: deciding which work is done by the human, which by AI, and in what interaction mode. Scoped to the current phase — closing issues #3–#12 to produce the buildable MVP spec.

Delegation planning is iterative and phase-scoped:

1. **Now — spec phase**: delegate the work of closing issues #3–#12 (this document).
2. **Later — build phase**: once #12 (MVP spec assembly) is done, generate a second delegation plan for implementation. That one will be much more automation-heavy, because a finished spec is precisely what makes coding work safely delegable.

The issue labels already encode most of the delegation signal: `wayfinder:grilling` issues are judgment calls the human must own; `wayfinder:research` issues are AI-delegable legwork; `wayfinder:prototype` issues are human-led content with AI drafting.

## Problem awareness

The destination is a buildable MVP spec for a local macOS workflow engine + workflow file format, with every decision tested against one acceptance workload: an LLM/agent pipeline running end-to-end. Issue #2 (domain model) is closed and captured in CONTEXT.md — that is the shared vocabulary everything else uses.

## Platform awareness

Claude is strong at surveying options, drafting schemas/specs, stress-testing designs, and assembling documents from settled decisions. It should **not** own decisions that are long-term commitments tied to the human's skills and taste (tech stack) or that define what the product *is* (scope cuts, the acceptance workload).

## Task delegation

In rough execution order:

| Issue | Who leads | Mode |
|---|---|---|
| #9 Acceptance workflow sketch | **Human** (content), AI (drafting) | Augmentation |
| #6 LLM worker execution survey | **AI** | Automation + review |
| #3 Engine tech stack | **Human** | Augmentation (grilling) |
| #4 / #5 Step-type & logicer subsets | **Human** | Augmentation (grilling) |
| #8 Persistence choice | **AI recommends**, human ratifies | Automation + review |
| #7 Checkpoint expression form | **AI surveys**, human picks | Augmentation |
| #10 Workflow file format v0 | **AI drafts**, human grills | Augmentation, heavy review |
| #11 Engine execution semantics | **AI drafts**, human grills | Augmentation, heavy review |
| #12 MVP spec assembly | **AI** | Automation + final review |

### Rationale

- **#9 first and human-led**: it is unblocked, blocks #12, and it is the yardstick every other decision is tested against. Only the human knows which real LLM pipeline PATH must run. Delegating this would mean AI defines its own acceptance criteria — a discernment trap. Human describes the pipeline; AI turns it into the rough JSON draft.
- **#6 is the most delegable item on the board**: pure research (Claude CLI vs Agent SDK vs API vs local runtimes), with a markdown artifact as output. Hand it to a research agent, then apply *product discernment*: check that session-lifecycle and cost/auth claims match current docs, since this landscape moves fast.
- **#3 stays human**: stack choice is a years-long commitment shaped by what the maintainer enjoys and can sustain. Use AI as a sparring partner (that is what the grilling label is for) — have it argue the Rust/Go/Dart/TS trade-offs against the multi-platform future — but the pick is a human call, and the *why* gets recorded (Diligence: the human is accountable for it).
- **#4/#5 are scope decisions** — "what's in the MVP" is product judgment. AI's role: test each candidate cut against the #9 workload ("can the acceptance pipeline still run without step type X?").
- **#8 and #7 are small, well-bounded technical choices** with limited blast radius — good candidates for "AI analyzes and recommends, human says yes/no."
- **#10 and #11 are the big drafting jobs**: once their blockers close, the inputs are all settled decisions, so AI can produce complete first drafts fast. The human's job shifts entirely to *discernment*: grill the drafts for edge cases (parallel-step failure, checkpoint false mid-run, context mutation ordering) rather than writing them from scratch.
- **#12 is assembly**, the most mechanical task — AI compiles, human does one final read for coherence and signs off (Deployment diligence: implementation sessions will trust the spec blindly, so the sign-off is a human responsibility).

## Cross-cutting practices (Description + Diligence)

- Each issue body is already a good *product description*. When delegating, add the *process description* — e.g. "recommend one option and argue against your own recommendation" — since that is what is missing.
- Keep doing what #2 did: settled decisions go into CONTEXT.md / the issue before closing, so drafts in #10–#12 build on recorded decisions, not conversation memory.
