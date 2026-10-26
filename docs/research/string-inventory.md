---
question: Where does user-visible text in PATH come from, and how much is there?
ticket: https://github.com/howardyang2009/PATH/issues/802
date: 2026-10-25
---

# User-visible string inventory

Counted on `feat/landing-language-switch-795` by [string-inventory.mjs](./string-inventory.mjs), which parses every non-test `.ts`/`.tsx` file in `packages/*/src` with `@babel/parser`. Rerun with `node docs/research/string-inventory.mjs "$PWD" rows.json`.

The counts are heuristic. A string counts when it reads as prose: it has a space and starts with a capital letter or contains a common English function word. SQL, CSS classes, paths, type literals and object keys are skipped. Expect a margin of about ±10% either way. The numbers are for sizing work, not a key list.

## Summary

| Package | Source kind | Count | With interpolation | Example |
|---|---|---:|---:|---|
| viewer | JSX text | 85 | 0 | `Cancel run` |
| viewer | JSX attribute (`aria-label`, `title`, `placeholder`…) | 23 | 3 | `title="Run detail"` |
| viewer | built string | 24 | 7 | `Confirm cancel?` |
| designer | JSX text | 147 | 0 | `by RheinWeg` |
| designer | JSX attribute | 110 | 20 | `aria-label="Palette"` |
| designer | built string | 111 | 30 | `Discard unsaved changes?` |
| client-core | built string (event lines, Resume reasons, hints) | 22 | 16 | `branch {x} matched no arm` |
| client-core | thrown error | 5 | 3 | `event stream request failed with status {x}` |
| server | `replyError`/`sendError` message | 40 | 16 | `not found` |
| server | built string (mostly messages passed to `replyError` later) | 80 | 42 | `precondition failed: the file no longer exists` |
| server | thrown error | 6 | 6 | `hosted mode refuses to start: - {x}` |
| engine | built string (run event reasons, refusals, reports) | 81 | 54 | `run "{x}" resolves to node "{x}", which is no longer in the workflow` |
| engine | thrown error | 23 | 16 | `cannot resolve "{x}": {x}` |
| schema | built string (validation issues shown in the Designer and API `details`) | 34 | 23 | `"{x}" reaches into a non-object value` |
| schema | thrown error | 5 | 5 | `step type "{x}": field "{x}" collides with an envelope field…` |

That is about **800 strings** that can reach a user:

| Source | Strings |
|---|---:|
| Viewer and Designer UI (JSX text, attributes, built strings) | ~500 |
| `client-core` | ~27 |
| Server, engine and schema messages | ~270 |

Server and engine messages are almost all lowercase, interpolated, technical sentences. More than half carry `{x}` parameters.

**Not counted (log-only, never shown in the UI):**
- 28 log and CLI strings in `bin/`, `launch.ts`, `cli*.ts` and `console.*` calls;
- SQL text.

## Plurals

Ten hand-made plurals, each written as `n === 1 ? … : …`. Each one needs an ICU `plural` message:

- `packages/viewer/src/launch-form.tsx:220`
- `packages/designer/src/open-workflow.ts:104`, `:199`, `:221`
- `packages/designer/src/problems-panel.tsx:43`, `:45`
- `packages/client-core/src/launch-secret-resupply.ts:102`
- `packages/engine/src/launch-facts.ts:124`
- `packages/engine/src/resolve-env.ts:134`
- `packages/engine/src/run-start.ts:124`

## Where the strings cluster

The five busiest files per package:

| Package | Busiest files (count) |
|---|---|
| viewer | `node-io.tsx` (20), `secrets-page.tsx` (16), `launch-panel.tsx` (13), `launch-form.tsx` (11), `resume-actions.tsx` (10) |
| designer | `editing-toolbar.tsx` (38), `block-tree.tsx` (27), `save-template-as-dialog.tsx` (25), `new-file-dialog.tsx` (24), `node-kind.ts` (22) |
| client-core | `resume-from-eligibility.ts` (9), `event-message.ts` (4), `credential-hints.ts` (3), `launch-secret-resupply.ts` (3), `sse-client.ts` (3) |
| server | `remap-user.ts` (11), `sandbox/sandboxed-runs.ts` (11), `routes/complete-run.ts` (6), `routes/resume-run.ts` (6), `sandbox/egress-anchor.ts` (5) |
| engine | `resume-legal-k.ts` (11), `run-report.ts` (11), `plugin-seam/scan.ts` (10), `continuation.ts` (8), `condition.ts` (7) |
| schema | `nodes.ts` (9), `dot-path.ts` (5), `config.ts` (4), `interpolation.ts` (4), `conditions.ts` (3) |

## Static site pages

| Page | Size | Notes |
|---|---|---|
| `packages/server/site/index.html` | 6 keys | Already translated inline (PR #800). |
| `packages/server/site/privacy.html` | ~930 words, 11 sections | Legal text with the Impressum. German binds. |
| `packages/server/site/terms.html` | ~820 words, 11 sections | Legal text. German binds. |

## What this means for the open decisions

- **Server and engine errors** (the "How do server and engine errors reach the user in their language?" ticket): about 270 messages across about 60 files.
  - The server already funnels refusals through one envelope (`replyError` / `sendError` give `{ error: { message, details } }`).
  - Engine messages reach the UI two ways: as run event reasons and as thrown errors that the server wraps.
  - Moving all of them to codes is the largest single piece of #795.
- **The Designer is about 2.5× the Viewer** (about 370 against 130 strings). Most Designer strings are attributes and toolbar labels.
- **`client-core` is small** (about 27 strings), but they are display sentences built from run state. They need ICU messages with parameters, not plain lookups.
