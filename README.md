# PATH

Workflow management system. Author a workflow as JSON (steps, workers, parallel/branch/while-do
blocks, checkpoints), run it locally or over HTTP, and watch it live in a web viewer. See
`CONTEXT.md` for the domain glossary (step, worker, task, run, logicer, checkpoint, ...) and
`docs/spec/mvp-spec.md` / `docs/api/server-api-v0.md` for the specs.

## Packages

| Package | What it is |
|---|---|
| `@path/schema` | Workflow file format v0 — types + validation |
| `@path/engine` | Runs workflows locally; `path` CLI |
| `@path/server` | HTTP + SSE API over the engine; `path-server` CLI |
| `@path/client-core` | Pure-TS API client + SSE client + run view-model (no framework) |
| `@path/viewer` | React web console over `client-core` — read-only run monitor |

## Getting started

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
```

Run a workflow directly with the engine CLI:

```bash
pnpm --filter @path/engine exec path run <workflow.json> [--config <config.json>] [--set key=value]...
pnpm --filter @path/engine exec path runs rm <root-run-id>   # or: path runs prune
```

Or serve it over HTTP and watch it in the viewer:

```bash
pnpm --filter @path/server exec path-server        # boots the v0 API + serves the built viewer
pnpm --filter @path/viewer run dev                 # viewer dev server, proxies API calls
```

## Status (2026-07-26)

Latest release: **v0.3.1** (viewer node-I/O stale-ref fix) — see `CHANGELOG.md` for the full history.

In progress — **cancellation** (delegation plan: `docs/delegation-plan-cancellation.md`), stopping a
run in flight from the CLI, the API, and the viewer:

- [x] #52 `@path/engine` external abort — cancel a root run in flight
- [x] #53 `@path/engine` CLI — graceful SIGINT (`^C` cancels the run)
- [ ] #54 `@path/server` — cancel route (`POST /v0/runs/:root_run_id/cancel`)
- [ ] #55 `@path/client-core` — `cancelRun()`
- [ ] #56 `@path/viewer` — Cancel button
- [ ] #57 Acceptance — cancel the release-notes pipeline in flight (closes the phase)

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox will download just the new packages — still fine. But if the
  lockfile drifts a lot over time, rebuild the image
  (`pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`) to re-warm it.
- The "limit hit mid-merge" failure mode can recur on long cycles. If it does, the same recovery
  applies — check `git status` for a half-finished merge before rerunning the loop.
