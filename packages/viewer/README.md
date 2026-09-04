# @path/viewer

The read-only web viewer for `path-server` — React (DOM) + Vite + TypeScript over the pure-TS
[`@path/client-core`](../client-core). Part of [wayfinder map #40](https://github.com/howardyang2009/PATH/issues/40).

## Layout

The app frame is **Variant A, the three-pane console** (pinned by [#44](https://github.com/howardyang2009/PATH/issues/44)):
`runs list │ run detail │ node I/O`, all three co-visible so nothing drops the live narrative.

Surfaces land pane by pane:

- **Runs list** (left) — landed ([#46](https://github.com/howardyang2009/PATH/issues/46)): root runs
  most-recent-first, status as color + glyph pill, click to select. Filter by status; the pane shows
  the latest 50 root runs (a monitor's window, not paginated history).
- **Run detail** (centre) — landed: root-run status and the **indented collapsible run tree**
  (parent run to child runs), live. The watched run is connected once, by `App`, through
  `connectRunViewModel`: tree hydrate, SSE subscribe, replay and the re-read that places a run the
  stream discovered all happen in client-core, so both live panes are views over one snapshot and
  hold no fetch logic of their own. Clicking a run in the tree selects it for the node-I/O pane.
  Under the tree, the **live narrative** renders the `seq`-ordered log-event stream with a liveness
  indicator, so a dropped and resuming stream is visible rather than silent.
- **Node I/O** (right) — landed: the selected run's **input and output objects** as mono JSON, read
  over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`, each with the blob ref it came from. The
  bytes are already secret-masked at the persistence boundary, so the pane renders them as served.
  Absence is decided by the run record's `input_ref`/`output_ref`, not by a 404: an unwritten object
  is never requested, and the ref appearing in a live snapshot re-reads it — so a pane opened
  mid-run picks up the output the moment the run finishes. **Refresh** re-reads on demand, for a ref
  whose content changed underneath.

Colors, glyphs and type come from `src/tokens.css` (the #44 token set); surfaces consume those vars
and do not re-pick colors. Run status is always **color + glyph, never hue alone**.

## Serve model

One origin, no CORS (matches the localhost single-trust-boundary stance):

- **Dev** — `pnpm --filter @path/viewer dev` runs the Vite dev server, which proxies `/v0/*` to a
  running `path-server`. Point it with `PATH_SERVER_URL` (default `http://localhost:8787`):

  ```sh
  path-server . --port 8787      # terminal 1
  pnpm --filter @path/viewer dev # terminal 2
  ```

- **Prod** — `pnpm --filter @path/viewer build` emits a static bundle to `dist/`, which
  `path-server` serves with SPA fallback (issue #42) from its default static dir
  (`packages/viewer/dist`).

## Test

`pnpm --filter @path/viewer test` — Vitest + React Testing Library (jsdom). Surfaces are rendered
against a `PathApiClient` over a stub `fetch`, so the tests cover the real client-core decode path
without a server. (The tests defer Playwright: read-only panes have no cross-page flow that needs a
browser driver yet.)
