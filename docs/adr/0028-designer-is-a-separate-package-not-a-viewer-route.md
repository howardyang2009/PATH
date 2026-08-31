# `@path/designer` is a separate package, not a viewer route

**Status:** accepted; resolves the package-boundary question of Wayfinder map
[#254](https://github.com/howardyang2009/PATH/issues/254) (assembled at
[#263](https://github.com/howardyang2009/PATH/issues/263)). Applies map **decision 5** (a new
`@path/designer` package, peer of `@path/viewer`, with no `@path/ui` React package extracted up front)
and **decision 2** (the Designer owns its own run/cancel/resume/detail surfaces and does not embed or
import the Viewer). Builds on
[ADR 0025](0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md)
(shared run-meaning moves into `@path/client-core`; React components do not) and
[ADR 0027](0027-two-bundles-one-origin-named-mounts-with-root-redirect.md) (two bundles, two mounts).
The wire and UI contract is [docs/spec/designer-spec.md § 0](../spec/designer-spec.md).

**Reverses** map [#40](https://github.com/howardyang2009/PATH/issues/40)'s out-of-scope note that the
Designer "reuses this viewer as a component." #40 is closed and not reopened; this ADR records that the
conflict is deliberate, not overlooked.

This decision earns a record on the three-part bar. It is **hard to reverse** (a build-graph and
dependency change touching both surfaces). It is **surprising without context** (it reverses #40, and it
declines the DRY instinct to share a UI package). And it is a **real trade-off** (duplicated view chrome
against a coupled or prematurely-shared package).

## Decision

`@path/designer` is a **new package, a peer of `@path/viewer`.** Each is a thin React surface over the
shared **`@path/client-core`**. The Designer is **not** a route added to the Viewer's app, **not** the
Viewer imported as a component library, and there is **no `@path/ui` React package** extracted up front.

Shared *logic* travels through `@path/client-core` (decision 14, ADR 0025); shared *components* are
deliberately **not** shared, because the two surfaces are meant to look different (decision 2).

Grounds the map fixed:

- `AppShell` is **pinned** by decision #44 — a shared shell is already spoken for and is not the seam.
- The Viewer is **router-less.** A "designer route" inside it would force a router onto a surface that
  has none — a Viewer-router decision this map does not take (ADR 0027 keeps the same stance for deep
  links).
- `packages/client-core/src/index.ts` **already names `designer`** a peer surface of the same core. The
  package boundary ratifies a seam the code already assumes.

## Considered options

- **A route inside `@path/viewer` (reuse it as a component, per #40).** Rejected: it forces a router onto
  the router-less Viewer, couples the two surfaces' builds and deploys, and — since the surfaces are meant
  to diverge in look (decision 2) — makes them share an app shell that fights the design. This is the #40
  assumption; it is reversed here on purpose.
- **Extract a shared `@path/ui` React package up front.** Rejected as speculative generality. The two
  surfaces are meant to look different, so a shared component package would be a premature abstraction
  over two views that share almost no chrome. If real component sharing later emerges, it can be extracted
  then; until then the seam stays at `@path/client-core` (decision 14), which holds *logic*, not `.tsx`.
- **Fold the Designer into the `@path/viewer` package as a second entry point.** Rejected: it still
  produces two bundles, two Vite `base`s, and two mounts (ADR 0027), so the package seam is cleaner drawn
  as two packages than as one package with two builds. ADR 0027's two named mounts already assume two
  `dist` directories.

## Consequences

- **Reversing this** — merging the packages, or extracting `@path/ui` — is a build-graph and dependency
  change touching both surfaces. Hence this record, so the next reader does not "DRY up" two views that
  were meant to look different.
- The two surfaces share **exactly `@path/client-core`**: ADR 0025's four moved units plus the run-meaning
  reused unchanged. Nothing else crosses between them.
- **Serving follows the packaging:** two packages produce two `dist` directories, which ADR 0027 mounts at
  `/viewer/` and `/designer/`. A packaging change would ripple into the mount layout.
- **Mobile and a shared-UI future stay open, not foreclosed.** The core/view seam (decision 14) is what
  keeps the option of a third surface cheap without pre-building `@path/ui` now.
