# PATH

PATH is a workflow management system. You write a workflow as JSON. A workflow has steps, workers,
and blocks (parallel, branch, while-do). A parallel block uses a `wait-one` or `do-not-wait` join. A
workflow can also have checkpoints. You run a workflow on your machine or over HTTP. You watch,
launch, and resume runs in a web viewer.

Read `CONTEXT.md` for the domain glossary. It defines step, worker, task, run, logicer, checkpoint,
and more. Read `docs/spec/mvp-spec.md` and `docs/api/server-api-v0.md` for the specs.

## Packages

| Package | What it is |
|---|---|
| `@path/schema` | The domain. It holds the workflow file format (`path/workflow@2`). It also holds the runtime vocabulary that execution produces: run status, log events, traces, and the v0 wire shapes. |
| `@path/engine` | Runs workflows locally. Provides the `path` CLI. |
| `@path/server` | An HTTP and SSE API over the engine. Provides the `path-server` CLI. |
| `@path/client-core` | A pure-TypeScript API client. It has an SSE client, a run view-model, and a run/workflow write surface. It needs no framework and no Node. |
| `@path/viewer` | A React web console over `client-core`. It monitors runs live. It launches and resumes runs. |

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
npx tsx packages/engine/bin/path.ts runs rm <root-run-id>   # or: runs prune [--yes] (confirms first)
npx tsx packages/engine/bin/path.ts runs -C <dir>             # target another project's .path/, git-style
```

`--resume` re-runs a stopped tree as a *successor* run. It reuses every node that already succeeded.
It re-runs the other nodes.

**Warning:** Resume is **at-least-once**. A re-run step can fire an external effect again, for example
a `git push` or an API `POST`. The engine cannot detect or prevent the duplicate. The workflow author
must make steps idempotent (mvp spec §5.6, `docs/research/resume-side-effect-contract.md`).

Or serve it over HTTP and watch it in the viewer:

```bash
pnpm --filter @path/viewer run build               # path-server serves dist/, so build it first
npx tsx packages/server/bin/path-server.ts . --port 8080   # v0 API + the built viewer
pnpm --filter @path/viewer run dev                 # or: viewer dev server, proxies API calls
```

The bins are TypeScript entry points. `tsx` runs them. There is no build step. There is no linked
`path` or `path-server` on your `PATH`. Thus `pnpm exec path-server` cannot find them.

The first argument to `path-server` is the project directory. The server reads and writes `.path/`
there. This argument defaults to the current directory. The engine CLI is different: it finds its
project directory from the workflow file location.

## Status (2026-08-20)

The latest release is **v0.5.1** (2026-08-20). See `CHANGELOG.md` for the full history. The `main`
branch is green. `pnpm -r run typecheck` is clean. 1119 tests pass: schema 235, engine 564, viewer
121, server 134, client-core 51, scripts 14.

The MVP is done. All three wayfinder maps are closed: #1 spec, #29 server API, and #40 viewer. The
release-notes pipeline passes its acceptance run (mvp spec §11).

The **cancellation** phase shipped as v0.4.0. After it, the codebase took two architecture-review
passes: v0.4.1 to v0.4.2, then v0.4.3. Then it started to open its deferred doors:

- **v0.4.3** — `$env` config sourcing (map #113). This is the first of #109's deferred doors. A config
  value can name an environment variable. It composes with `$secret`. Thus the sourced value is both
  addressable and masked.
- **v0.4.4** — **resume** (map #158, then #168). This is the second door. A run can stop from a crash
  or a cancel. It then re-runs as a *successor*. The successor reuses every node whose recorded run
  already succeeded. It re-runs the other nodes. The command is
  `path run <workflow.json> --resume <root-run-id>`. Resume is at-least-once. A re-run step can fire an
  external effect again. Thus the workflow author must make steps idempotent (mvp spec §5.6).
- **v0.5.0** — two parts grow up. First, the engine learns to fan out and rejoin. `wait-one` races its
  branches and keeps the first winner (ADR 0004). `do-not-wait` launches a branch. The enclosing run
  then continues behind a join barrier (ADR 0008 and 0009). Second, the viewer stops being read-only.
  It discovers the store's workflows. It launches runs. It resumes cancelled or failed runs from the
  console. A new `client-core` write surface and a server `GET /v0/workflows` discovery endpoint
  support this. A CSRF/origin gate protects every mutating route. Under both parts, a durable GUID
  rebuilds workflow and node identity (format `path/workflow@1`). Thus a rename never breaks reuse or
  resume. Each root run now records its source-workflow identity. `path runs list` gains a `workflow`
  column and the `--workflow` and `--workflow-id` filters.
- **v0.5.1** — the workflow format grows up again. The three container slot shapes of
  `path/workflow@1` collapse into one uniform node shape. A new `sequence` logicer carries the
  multi-step case. That case used to hide in a bare node array (ADR 0014). A parallel branch is now a
  node. The branch arm, `else`, and `while-do` slots each hold one `node`. The new format is
  `path/workflow@2`. It is clean-slate and codemod-migrated. The codemod
  `scripts/migrate-workflow-format-v2.ts` fills once and is idempotent. There is no DB break. Two
  Opus 5 refactors are included (#290). `loadWorkflowTree` returns a `LoadedWorkflow`. Both launch
  routes collapse behind one `prepareWorkflow`.

### What's next

- #110 `@path/server` — replay a run's narrative from `log_events` when the `ndjson` backend is off.
  This is the one known product gap. The audit record is complete. The API cannot serve it yet.
- #109 the **v-next register** — a promotion trigger for each deferred door in mvp spec §10. This
  stays open. Each door moves into its own wayfinder map when its trigger fires. `$env` (v0.4.3) and
  resume (v0.4.4) have shipped. An API-endpoint step type and automatic in-run retry are still
  deferred.

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox downloads only the new packages. This is still fine. But the lockfile
  can drift a lot over time. If it does, rebuild the image to re-warm it:
  `pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`.
- The "limit hit mid-merge" failure can happen again on long cycles. If it does, use the same
  recovery. Check `git status` for a half-finished merge before you run the loop again.
