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

Run a workflow directly with the engine CLI (from the repo root):

```bash
npx tsx packages/engine/bin/path.ts run <workflow.json> [--config <config.json>] [--set key=value]...
npx tsx packages/engine/bin/path.ts runs rm <root-run-id>   # or: runs prune
```

Or serve it over HTTP and watch it in the viewer:

```bash
pnpm --filter @path/viewer run build               # path-server serves dist/, so build it first
npx tsx packages/server/bin/path-server.ts . --port 8080   # v0 API + the built viewer
pnpm --filter @path/viewer run dev                 # or: viewer dev server, proxies API calls
```

The bins are TypeScript entry points run through `tsx`; there is no build step and no linked
`path`/`path-server` on your `PATH`, so `pnpm exec path-server` will not find them. `path-server`'s
first argument is the project directory — where `.path/` is read and written — and it defaults to the
cwd; the engine CLI instead derives its project directory from the workflow file's own location.

## Status (2026-07-26)

Latest release: **v0.3.1** (viewer node-I/O stale-ref fix) — see `CHANGELOG.md` for the full history.

**Cancellation** (delegation plan: `docs/delegation-plan-cancellation.md`) — stopping a run in flight
from the CLI, the API, and the viewer — is code-complete and has passed its acceptance run. The
release decision (and so the version) is open; see `CHANGELOG.md` under Unreleased.

- [x] #52 `@path/engine` external abort — cancel a root run in flight
- [x] #53 `@path/engine` CLI — graceful SIGINT (`^C` cancels the run)
- [x] #54 `@path/server` — cancel route (`POST /v0/runs/:root_run_id/cancel`)
- [x] #55 `@path/client-core` — `cancelRun()`
- [x] #56 `@path/viewer` — Cancel button
- [x] #57 Acceptance — cancel the release-notes pipeline in flight (closes the phase)

Raised by #57's acceptance run:

- [x] #59 `@path/server` — `POST /v0/runs` passed the project root where the engine expects the
      workflow file's directory, so a nested workflow ref never resolved
- [x] #61 `@path/engine` CLI — `runs prune` ignored trailing arguments, so `--help` pruned everything
- [ ] #60 A forced second `^C` leaves a lying `running` row, with nothing to reconcile it —
      open on a design decision, not on the work: accept and document, write the terminal rows before
      exiting, or reconcile stale rows on read

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox will download just the new packages — still fine. But if the
  lockfile drifts a lot over time, rebuild the image
  (`pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`) to re-warm it.
- The "limit hit mid-merge" failure mode can recur on long cycles. If it does, the same recovery
  applies — check `git status` for a half-finished merge before rerunning the loop.
