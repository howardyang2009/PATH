# The Designer reuses the Viewer's run panels

**Status:** accepted; **supersedes**
[ADR 0028](0028-designer-is-a-separate-package-not-a-viewer-route.md) on its decision **2** (the
Designer "does not embed or import the Viewer"). ADR 0028's decision **5** still holds in part —
`@path/designer` stays a separate package with its own bundle and mount
([ADR 0027](0027-two-bundles-one-origin-named-mounts-with-root-redirect.md)) — but the two surfaces are
no longer forbidden from sharing `.tsx`: the Designer now depends on `@path/viewer` and mounts its three
run **read** panels directly. Builds on
[ADR 0025](0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md)
(shared run-*meaning* lives in `@path/client-core`), which is unchanged — React components still do not
go into `client-core`; they travel from the Viewer instead.

This decision earns a record on the three-part bar. It is **hard to reverse** (a build-graph and
dependency change, and it un-forks four panels). It is **surprising without context** (it reverses the
ADR 0028 boundary that a guardrail test used to enforce). And it is a **real trade-off** (a Designer→Viewer
package dependency against the duplicated, drifting fork it replaces).

## Decision

`@path/designer` **depends on `@path/viewer`** and reuses its run read panels — `RunsList`, `RunDetail`,
`NodeIo` — imported from the Viewer's package barrel (`@path/viewer`) plus its stylesheet
(`@path/viewer/viewer.css`). The Designer's run dock composes these three panels; it keeps only its own
run *authoring* chrome — the save-first launch form (`RunLaunch`) and the canvas **projection**
(`run-projection`), which have no Viewer equivalent.

The panels are **parametrised, not forked**, so one component serves both surfaces:

- `RunsList` takes an optional `workflowId` scope. `undefined` is the Viewer's cross-workflow rail;
  a string scopes the list to one workflow's history (the Designer, watching the file it has open);
  `null` is a scoped surface with nothing open yet (an idle note, no reads).
- `RunDetail` and `NodeIo` are unchanged between surfaces — the Designer author and the Viewer operator
  read a run identically, down to the narrative and the E (error) block.

## Why ADR 0028 is reversed

ADR 0028 declined to share components "because the two surfaces are meant to look different," and left
the door open: *"If real component sharing later emerges, it can be extracted then."* That sharing did
emerge, and against the *run* surfaces specifically:

- The three run read panels are meant to look **the same**, not different. A run is a run; an author
  inspecting one wants the same tree, the same node I/O, the same error block the operator sees. ADR
  0028's "meant to look different" holds for the authoring canvas, not for the run read surfaces.
- The fork **drifted**, which is the failure ADR 0028's own consequences warned about. The Viewer gained
  the E (error) block ([#401](https://github.com/howardyang2009/PATH/pull/401)) while the Designer fork
  had no narrative at all — the two surfaces told a different story about the same run, which is exactly
  what the shared `client-core` seam exists to prevent, one layer up.

## Considered options

- **Extract a shared `@path/client-react` (the `@path/ui` package ADR 0028 named).** Viable and the more
  neutral shape — Viewer and Designer stay peers, both depending on the new package, neither on the
  other. Rejected for now as more moving parts than the sharing warrants: only three panels are shared,
  they already live in the Viewer, and the Viewer is where they are authored and tested. If a third
  surface (mobile) later needs them, the barrel these panels are exported through is the seam to lift
  into `@path/client-react` then — the same "extract when it emerges" reasoning, applied a step later.
- **Keep the fork (ADR 0028 status quo).** Rejected: it is the drift above, made permanent.
- **Move the panels into `@path/client-core`.** Rejected by ADR 0025 and unchanged here: `client-core`
  is framework-free (`No React, no DOM`); a React panel there forces React onto every core consumer.

## Consequences

- **The dependency is one-way:** `@path/designer` → `@path/viewer` → `@path/client-core`. The Viewer does
  not depend on the Designer. The old `no-viewer-import.test.ts` guardrail is removed, since it asserted
  the boundary this ADR lifts.
- **Styling coupling:** the Designer imports `@path/viewer/viewer.css` for the panels, loaded *before*
  `designer.css` so the Designer's own frame classes still win the few names the two stylesheets share.
  The Designer keeps its own `tokens.css` palette.
- **The Viewer is now a library as well as an app.** Its `package.json` gains an `exports` barrel
  (`src/index.ts`) naming the reusable panels and hooks. Its `App`/`main` entry is untouched.
- **A shared-`@path/client-react` future stays open,** exactly as ADR 0028 kept it open — the Viewer's
  barrel is the seam that would move.
