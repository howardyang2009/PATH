# PATH Delegation Plan — Phase 3: MVP Viewer (issues #41–#45)

A delegation plan in the [AI Fluency](https://anthropic.skilljar.com/ai-fluency-framework-foundations) sense: deciding which work is done by the human, which by AI, and in what interaction mode. This is the build-phase plan for the [MVP viewer map (#40)](https://github.com/howardyang2009/PATH/issues/40) — the web monitor over `@path/server`.

Predecessor: [Phase 2: MVP Implementation](./delegation-plan-implementation.md), which closed the engine (#15–#26). Between then and now, the [server API map (#29)](https://github.com/howardyang2009/PATH/issues/29) shipped `@path/server` (v0 HTTP + SSE) as a spec-then-build effort with no separate delegation doc — it was human-led grilling throughout. This phase is the first client. The plan re-tilts toward automation for the same reason Phase 2 did: the map's locked architecture decisions and the existing `server-api-spec.md` are fixed points every ticket verifies against.

## Problem awareness

The destination is map #40's reached-criterion: a working browser viewer that, against a real run of the release-notes acceptance workflow, lists it, opens it, streams the live run tree + SSE narrative, survives a mid-run reload (`Last-Event-ID` replay), and shows a node's masked input/output. **The close that IS "done" is the dogfood/acceptance sign-off ticket** — currently fog on the map, graduating once the surfaces exist. This plan covers the foundational batch (#41–#45) that makes that close reachable.

The main failure mode of this phase is **scope creep into designer territory** — a launch button, an editable field, a graph canvas — and **over-investing in polish AI cannot verify unattended**. The map's read-only / core-view-seam / indented-tree-not-graph decisions are the guardrails; a deviation is a map-amendment conversation, not a silent diff.

Work order from the blocking graph: #41, #42, #43, #44 are the frontier (all unblocked, parallel-safe); #45 is blocked by #41. The four viewer UI-surface tickets and the dogfood close remain fog until #44 pins the layout and #45 lands the shell.

## Platform awareness

- **What makes this delegable:** the endpoint contracts already exist ([server-api-spec.md](./spec/server-api-spec.md), [server-api-v0.md](./api/server-api-v0.md)) and `@path/schema` supplies the wire types — the client is written *to* a fixed contract, not inventing one. The two server tickets mirror the existing `@path/server` vitest patterns exactly.
- **Where AI is strong here:** mechanical, well-specified server additions (#42 static serving, #43 blob route) against an existing test style; typed client code against known wire shapes (#41); Vite/React scaffolding (#45).
- **Where the risk concentrates:**
  - **Long-lived interface:** `@path/client-core`'s public API (#41) — the designer and every future mobile surface import it. Like `@path/schema` (#15) in Phase 2: cheap to shape now, expensive forever after.
  - **Silent failure surfaces:** SSE reconnect in #41 (a dropped or duplicated event on `Last-Event-ID` replay passes green tests but corrupts the narrative — the Phase 2 #24 concurrency lesson); the SPA fallback in #42 (a fallback that answers `index.html` for an unmatched `/v0` path silently breaks the API); path-traversal in #43 (the `name` enum must not escape the blob dir).
  - **What AI cannot verify AFK:** #44 — "does the run tree read well, does the streaming log feel right" is a human judgment in pixels, not a test.
- **External risk:** low — no new auth, no real token cost this phase. The nearest analogue is the **prototype**: pull #44 to the front so the human reacts to a concrete layout early, unblocking the fog UI tickets while there is slack.

## Task delegation

In frontier order. "Automation" = AI implements and verifies, human reads the `/code-review` output and diff summary. "+ focused review" = plus one named thing the human personally inspects. "+ adversarial review" = the human attacks a silent failure mode. "Augmentation" = human in the loop, AI cannot self-verify.

| Issue | Who leads | Mode | Human discernment focus |
|---|---|---|---|
| [#41 `@path/client-core`](https://github.com/howardyang2009/PATH/issues/41) | AI | Automation + focused review + **adversarial** | Two foci: the **public API surface** (designer + mobile import it — a long-term commitment); and **adversarially attack SSE reconnect** — drop mid-stream, reconnect with `Last-Event-ID`, verify no gap and no duplicate |
| [#42 static serving + SPA fallback](https://github.com/howardyang2009/PATH/issues/42) | AI | Automation + focused review | The **SPA fallback must not swallow `/v0`** — verify an unmatched API path still returns JSON 404, only non-`/v0` GETs fall back to `index.html`; asset path stays inside the bundle dir |
| [#43 blob route](https://github.com/howardyang2009/PATH/issues/43) | AI | Automation + focused review | **Path-traversal safety** — the `name` enum and `run_id`/`root_run_id` cannot resolve a file outside the run's blob dir; 404 (not 500) on unknown refs |
| [#44 prototype layout + tokens](https://github.com/howardyang2009/PATH/issues/44) | **AI + human in the loop** | Augmentation | Human reacts to pixels: does the **indented run tree** read as a hierarchy, does the **streaming narrative** density/order feel right, are the **status colors** legible in light + dark. AI builds the throwaway; the human's reaction IS the deliverable |
| [#45 `@path/viewer` scaffold](https://github.com/howardyang2009/PATH/issues/45) | AI | Automation + focused review | The **core/view seam** — confirm no domain logic (tree assembly, SSE parsing, status derivation) leaks into React; the view only subscribes to `@path/client-core`. Also ratify the smoke-test tooling choice |

### Rationale

- **The board is automation-heavy by design**, mirroring Phase 2: the map spent the human's judgment on the irreversible calls (surfaces vs monolith, the core/view seam, read-only scope, serve model) precisely so the build would not need it per-ticket. The locked decisions win; an implementer disagreement is a map-amendment conversation.
- **#41 carries two kinds of risk at once**, so it gets both focused and adversarial review. The API surface is a *long-lived interface* (focused review, like #15) — but the reconnect logic is a *silent failure surface* (adversarial, like #24). These are different jobs: read the shape, attack the stream.
- **#42 and #43 are single-focus** because each has exactly one non-obvious way to be silently wrong — the fallback eating `/v0`, and the blob path escaping its dir. Name that one thing; reading the rest of the diff line-by-line catches nothing.
- **#44 is human-led judgment inverted from the others.** Everywhere else AI verifies and the human spot-checks; here AI cannot verify at all — UX legibility is not a test. The human reacts, AI iterates the throwaway.
- **The yardstick stays human.** The eventual dogfood/acceptance close (still fog) is this phase's #26: AI must not both build the viewer and declare its own acceptance passed. When it graduates it is **human-led / Augmentation** — the human opens the browser, watches a real acceptance run stream live, and signs off.

## Cross-cutting practices (Description + Diligence)

- **Process description is standardized:** each server/core ticket runs as a fresh-context `/implement` session against the issue — TDD slices, then two-axis `/code-review` (Standards + Spec), then commit referencing the issue. #44 runs via `/prototype`. Context is cleared between tickets; the ticket + map decisions are the contract, never conversation memory.
- **Performance description:** commits reference issue numbers; each closing comment states what was verified and how (which vitest cases, which manual/adversarial checks). A closed blocker must actually mean *done* — #45 and every fog UI ticket inherit #41's correctness.
- **Creation diligence:** no scope creep past the map's read-only / indented-tree / two-server-additions decisions. Anything wider (launch button, graph editor, stderr/context blobs, mobile stack) goes to the tracker — the designer or mobile map, or the map's *Not yet specified* — not into the diff. Pin React / Vite / react-dom versions at scaffold; no silent upgrades.
- **Transparency diligence:** `@path/client-core` and `@path/viewer` are AI-implemented with human review concentrated as the table describes; this document is the record of that arrangement.
- **Deployment diligence — the non-delegable sign-offs, by name:**
  1. **#41 `@path/client-core` public API surface** — approved by the human before downstream tickets build on it (long-lived; designer + mobile depend on it).
  2. **#44 prototype look-and-feel** — the human's reaction is required; the layout/tokens are not "passed" by AI.
  3. **The dogfood/acceptance close** (when it graduates from fog) — the human opens the browser, watches the live acceptance run incl. the mid-run reload, and personally signs off. This is the viewer's release decision and may not be delegated.

## Trigger for the next plan

When #41–#45 close and the map's fog graduates into the viewer UI-surface tickets + the dogfood close, re-decide the split in a **Phase 4** plan (the UI-surface build). Expect it to stay automation-heavy for the surfaces, with the dogfood close as the single human-led yardstick.
