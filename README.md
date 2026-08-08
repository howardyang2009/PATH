# PATH

Workflow management system. Author a workflow as JSON (steps, workers, parallel/branch/while-do
blocks, checkpoints), run it locally or over HTTP, and watch it live in a web viewer. See
`CONTEXT.md` for the domain glossary (step, worker, task, run, logicer, checkpoint, ...) and
`docs/spec/mvp-spec.md` / `docs/api/server-api-v0.md` for the specs.

## Packages

| Package | What it is |
|---|---|
| `@path/schema` | The domain: workflow file format v0, plus the runtime vocabulary its execution produces (run status, log events, traces, the v0 wire shapes) |
| `@path/engine` | Runs workflows locally; `path` CLI |
| `@path/server` | HTTP + SSE API over the engine; `path-server` CLI |
| `@path/client-core` | Pure-TS API client + SSE client + run view-model (no framework, no Node) |
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
npx tsx packages/engine/bin/path.ts run <workflow.json> --resume <root-run-id>   # re-run a stopped tree
npx tsx packages/engine/bin/path.ts runs                     # list root runs (--limit, --status)
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

## Status (2026-08-08)

Latest release: **v0.4.3** (2026-08-02) — see `CHANGELOG.md` for the full history. `main` is green:
`pnpm -r run typecheck` clean, 899 tests passing (schema 201, engine 488, viewer 89, server 79,
client-core 42).

The MVP is done — all three wayfinder maps are closed (#1 spec, #29 server API, #40 viewer) and the
release-notes pipeline passes its acceptance run (mvp spec §11). The last three releases were the
**cancellation** phase and then two passes over the codebase's own shape:

- **v0.4.0** — cancellation (delegation plan: `docs/delegation-plan-cancellation.md`): stopping a run
  in flight from the CLI (`^C`), the API (`POST /v0/runs/:root_run_id/cancel`) and the viewer,
  acceptance run and all.
- **v0.4.1** — one SSE channel leak fixed (#74), and the engine's *interior* given the seams the
  cancellation phase kept revealing it lacked: `Project` owns run assembly (#64), `@path/schema` owns
  the runtime vocabulary (#66) and one condition grammar (#68), one walk over the node tree (#70).
- **v0.4.2** — first architecture review: five deepenings built (`RunArchive`, `LiveRuns`, the
  event-frame codec, `runNode`, `eventOutcome`/`buildRunTree`), a sixth refused with its reasons filed
  (#91), and a real masking bug shipped as the fix it turned up.
- **v0.4.3** — the second architecture review (every recent deepening left the module it superseded
  in place; six withdrawals landed, two declined with reasons filed) ships alongside the first of
  #109's deferred doors: `$env` config sourcing (map #113), a config value that names an environment
  variable and composes with `$secret` so the sourced value is both addressable and masked.

**Unreleased on `main`** — **resume** (map #142 → #158 → #168), the second of #109's deferred doors.
A crash-interrupted or cancelled run re-runs as a *successor* that reuses every node whose recorded
run already succeeded and re-runs the rest — `path run <workflow.json> --resume <root-run-id>`. All
of #168's tickets landed:

- [x] #172 the reuse plan — which node ids reuse a prior run, matched by `(node id, succeeded)`
- [x] #173 `Project.resume` — the engine-side successor run, original tree read-only throughout
- [x] #174 `path runs` — the bare listing, with each run's `resumed-from` lineage
- [x] #175 `runs rm --force` — the guard on deleting a tree a live reuse-marker still points at
- [x] #176 cost-SUM crossing tree boundaries — a reused node's spend summed from the original tree
- [x] #177 `path run --resume` — the CLI flag and its successor-run reporting
- [x] #178 the acceptance exercise (kill mid-`while-do`, resume, assert no re-bill) + doc de-staling

Resume is **at-least-once**: a re-run step that already had an external effect can fire it again —
idempotency is the workflow author's burden (mvp spec §5.6).

### What's next

- #110 `@path/server` — replay a run's narrative from `log_events` when the `ndjson` backend is off.
  The one known product gap: the audit record is complete, the API just cannot serve it.
- #109 the **v-next register** — a promotion trigger for each deferred door in mvp spec §10. Stays
  open; each door graduates into its own wayfinder map when its trigger fires. Two of its ordered
  three have shipped — `$env` (map #113, v0.4.3) and resume (map #158/#168, unreleased on `main`) —
  leaving an API-endpoint step type and automatic in-run retry deferred.

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox will download just the new packages — still fine. But if the
  lockfile drifts a lot over time, rebuild the image
  (`pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`) to re-warm it.
- The "limit hit mid-merge" failure mode can recur on long cycles. If it does, the same recovery
  applies — check `git status` for a half-finished merge before rerunning the loop.
