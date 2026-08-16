# PATH

Workflow management system. Author a workflow as JSON (steps, workers, parallel/branch/while-do
blocks, `wait-one` and `do-not-wait` joins, checkpoints), run it locally or over HTTP, and watch,
launch, and resume runs live in a web viewer. See
`CONTEXT.md` for the domain glossary (step, worker, task, run, logicer, checkpoint, ...) and
`docs/spec/mvp-spec.md` / `docs/api/server-api-v0.md` for the specs.

## Packages

| Package | What it is |
|---|---|
| `@path/schema` | The domain: workflow file format (`path/workflow@1`), plus the runtime vocabulary its execution produces (run status, log events, traces, the v0 wire shapes) |
| `@path/engine` | Runs workflows locally; `path` CLI |
| `@path/server` | HTTP + SSE API over the engine; `path-server` CLI |
| `@path/client-core` | Pure-TS API client + SSE client + run view-model + run/workflow write surface (no framework, no Node) |
| `@path/viewer` | React web console over `client-core` — monitors runs live, and launches and resumes them |

## Getting started

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
```

Run a workflow directly with the engine CLI (from the repo root):

```bash
npx tsx packages/engine/bin/path.ts run <workflow.json> [--config <config.json>] [--set key=value]...
npx tsx packages/engine/bin/path.ts run <workflow.json> --resume <root-run-id>   # re-run a stopped tree
npx tsx packages/engine/bin/path.ts runs                     # list root runs (--limit, --status, --workflow)
npx tsx packages/engine/bin/path.ts runs rm <root-run-id>   # or: runs prune
npx tsx packages/engine/bin/path.ts runs -C <dir>             # target another project's .path/, git-style
```

`--resume` re-runs a stopped tree as a *successor* run: it reuses every node that already succeeded
and re-runs the rest. Resume is **at-least-once** — a re-run step that already had an external effect
(a `git push`, an API `POST`) can fire it again, and the engine cannot detect or prevent the
duplicate. Making steps idempotent is the workflow author's job (mvp spec §5.6,
`docs/research/resume-side-effect-contract.md`).

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

## Status (2026-08-16)

Latest release: **v0.5.0** (2026-08-16) — see `CHANGELOG.md` for the full history. `main` is green:
`pnpm -r run typecheck` clean, 1055 tests passing (schema 219, engine 540, viewer 121, server 124,
client-core 51).

The MVP is done — all three wayfinder maps are closed (#1 spec, #29 server API, #40 viewer) and the
release-notes pipeline passes its acceptance run (mvp spec §11). Since the **cancellation** phase
(v0.4.0), the codebase took two architecture-review passes (v0.4.1–v0.4.2, then v0.4.3) and then
started opening its deferred doors:

- **v0.4.3** — `$env` config sourcing (map #113), the first of #109's deferred doors: a config value
  that names an environment variable and composes with `$secret`, so the sourced value is both
  addressable and masked.
- **v0.4.4** — **resume** (map #158 → #168), the second door. A crash-interrupted or cancelled run
  re-runs as a *successor* that reuses every node whose recorded run already succeeded and re-runs the
  rest — `path run <workflow.json> --resume <root-run-id>`. At-least-once: a re-run step that already
  had an external effect can fire it again, so idempotency is the workflow author's burden (mvp spec
  §5.6).
- **v0.5.0** — two things grow up. The engine learns to **fan out and rejoin**: `wait-one` races its
  branches and keeps the first winner (ADR 0004), `do-not-wait` launches a branch and lets the
  enclosing run continue behind a join barrier (ADR 0008/0009). And the **viewer stops being
  read-only** — it discovers the store's workflows, launches runs, and resumes cancelled or failed
  runs from the console, backed by a new `client-core` write surface and a server `GET /v0/workflows`
  discovery endpoint (with a CSRF/origin gate on every mutating route). Underneath both, workflow and
  node identity is rebuilt on a durable GUID (format `path/workflow@1`) so a rename never breaks reuse
  or resume; each root run now records its source-workflow identity, and `path runs list` grows a
  `workflow` column and `--workflow` / `--workflow-id` filters.

### What's next

- #110 `@path/server` — replay a run's narrative from `log_events` when the `ndjson` backend is off.
  The one known product gap: the audit record is complete, the API just cannot serve it.
- #109 the **v-next register** — a promotion trigger for each deferred door in mvp spec §10. Stays
  open; each door graduates into its own wayfinder map when its trigger fires. `$env` (v0.4.3) and
  resume (v0.4.4) have shipped, leaving an API-endpoint step type and automatic in-run retry deferred.

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox will download just the new packages — still fine. But if the
  lockfile drifts a lot over time, rebuild the image
  (`pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`) to re-warm it.
- The "limit hit mid-merge" failure mode can recur on long cycles. If it does, the same recovery
  applies — check `git status` for a half-finished merge before rerunning the loop.
