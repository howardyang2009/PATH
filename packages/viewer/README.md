# @path/viewer

The read-only web viewer for `path-server` — React (DOM) + Vite + TypeScript over the pure-TS
[`@path/client-core`](../client-core). Part of [wayfinder map #40](https://github.com/howardyang2009/PATH/issues/40).

This package is currently the **scaffold shell** (issue #45): app wiring, dev/prod serve model,
design tokens, and a smoke screen that lists root runs to prove the core seam end-to-end. The four
real read surfaces (runs list, run tree, live narrative, node I/O panel) graduate as their own
tickets.

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

`pnpm --filter @path/viewer test` — Vitest + React Testing Library (jsdom), component-render
happy-path. (Playwright was considered and deferred: the smoke screen has no cross-page flow to
warrant a browser driver yet.)
