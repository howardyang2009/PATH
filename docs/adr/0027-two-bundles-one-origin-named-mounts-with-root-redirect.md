# Two bundles, one origin: named mounts with a root redirect

`path-server` serves both the Viewer and the Designer from a **single origin** (map #254 decision 13:
the no-auth, localhost-bind, no-CORS, #237-origin-gate posture rests on one origin). This ADR fixes
*how* the two static bundles share that origin and why the Viewer no longer sits at `/`.

## Decision

Two **named mounts**: the Viewer at `/viewer/`, the Designer at `/designer/`. The bare root `/`
issues a **302** redirect to `/viewer/`. A GET is routed by path prefix to the matching mount, the
prefix is stripped, and the remainder resolves within that mount's static dir with its **own** SPA
fallback to that mount's `index.html`. `/v0/*` is untouched (its unmatched routes keep JSON 404s), and
any other non-prefixed, non-`/v0` path is a plain 404. The server learns the second directory through
a second `designerStaticDir` parameter — two hardcoded mounts, not an open mount table. Each mount's
`serveStatic` no-ops to a 404 when its bundle is unbuilt, so a missing Designer (or Viewer) degrades
rather than crashes. Each bundle is built with a matching Vite `base` (`/viewer/`, `/designer/`).

The two surfaces do **not** cross-link in v1, and the Viewer stays **router-less**: no run-scoped
deep link points into it.

## Considered options

- **Viewer at `/`, Designer at `/designer/` (no redirect).** The narrower change — the Viewer's URL
  and build are untouched. Rejected in favour of symmetry: with named mounts neither surface is
  privileged with the root, the redirect target is a single changeable line, and both bundles share
  one base-prefixed shape. The cost accepted is real: the Viewer must now build with `base:/viewer/`,
  and anything that assumed `GET /` returns the Viewer's `index.html` (server acceptance tests
  included) must follow the 302 to `/viewer/`.
- **Two ports / two origins.** Rejected by decision 13: it dissolves the single-origin security
  posture.
- **An open mount table.** Rejected as speculative generality: the map fixes exactly two mounts.

## Consequences

- Reversing the layout (moving the Viewer back to `/`) means changing its `base`, the redirect, and
  any bookmarks — hence this record, so the next reader does not "fix" the Viewer back to the root
  believing the root was free.
- The Designer carries its own run surfaces ([ADR 0025](./0025-designer-carries-all-seven-run-surfaces-reshaped-run-meaning-moves-into-client-core.md)),
  so a "run this workflow" gesture never leaves the Designer. That is why no cross-surface deep link
  is specified; adding one later is a Viewer-router decision, not a serving decision.
