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
- **Run detail** (centre) — placeholder; status + run tree + live narrative land under map #40.
- **Node I/O** (right) — placeholder; lands with the run-tree surface.

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
without a server. (Playwright was considered and deferred: read-only panes have no cross-page flow
to warrant a browser driver yet.)
