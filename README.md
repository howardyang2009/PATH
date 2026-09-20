# PATH

PATH is a workflow management system. You write a workflow as JSON. A workflow has steps, workers,
and controllers (sequence, parallel, branch, while-do, checkpoint). A parallel controller uses a
`wait-one` or `do-not-wait` join. A `person-activity` step suspends its run until an operator completes
it. You run a workflow on your machine or over HTTP. You watch, launch, resume, and complete runs in a
web viewer. You author workflow files on a visual canvas in the designer.

Read `CONTEXT.md` for the domain glossary. It defines step, worker, task, run, controller, checkpoint,
and more. Read `docs/spec/mvp-spec.md` and `docs/api/server-api-v0.md` for the specs.

## Packages

| Package | What it is |
|---|---|
| `@path/schema` | The domain. It holds the workflow file format (`path/workflow@4`) and the registry factory that opens its node union to plugin step types. It also holds the runtime vocabulary that execution produces: run status, log events, traces, and the v0 wire shapes. |
| `@path/engine` | Runs workflows locally. Provides the `path` CLI. It discovers leaf step types as plugins under `step-plugins/` and exposes the `@path/engine/plugin` seam a step-type plugin compiles against. |
| `@path/server` | An HTTP and SSE API over the engine. Provides the `path-server` CLI. |
| `@path/client-core` | A pure-TypeScript API client. It has an SSE client, a run view-model, and a run/workflow write surface. It needs no framework and no Node. |
| `@path/viewer` | A React web console over `client-core`. It monitors runs live. It launches and resumes runs. |
| `@path/designer` | A React authoring console over `client-core`. It opens, edits, and saves workflow files on a live canvas. `path-server` serves it at `/designer/`. It is a peer of the viewer and never imports it. |

## Getting started

You need Node 24 or later (`engines.node` is `>=24`).

```bash
pnpm install
pnpm -r run typecheck
pnpm -r run test
```

Run a workflow directly with the engine CLI (from the repo root):

```bash
npx tsx packages/engine/bin/path.ts run <workflow.json> [--config <config.json>] [--set key=value]...
npx tsx packages/engine/bin/path.ts run <workflow.json> --worker-default <type>=<name>...  # launch default
npx tsx packages/engine/bin/path.ts run <workflow.json> --resume <root-run-id>   # re-run a stopped tree
npx tsx packages/engine/bin/path.ts run <workflow.json> --resume <root-run-id> --from <run-id>  # from boundary K
npx tsx packages/engine/bin/path.ts run <workflow.json> --resume <root-run-id> --list-eligible  # list K candidates
npx tsx packages/engine/bin/path.ts runs                     # list root runs (--limit, --status, --workflow)
npx tsx packages/engine/bin/path.ts runs rm <root-run-id>   # or: runs prune [--yes] (confirms first)
npx tsx packages/engine/bin/path.ts runs -C <dir>             # target another project's .path/, git-style
```

`--resume` re-runs a stopped tree as a *successor* run. It reuses every node that already succeeded.
It re-runs the other nodes.

`--from <run-id>` names the rerun boundary K inside that resume. Every node before K reuses its result;
K and the nodes after it re-run. `--list-eligible` prints the candidate boundaries and launches nothing.
A launch worker-default is fixed at launch, so `--worker-default` is refused with `--resume`.

**Warning:** Resume is **at-least-once**. A re-run step can fire an external effect again, for example
a `git push` or an API `POST`. The engine cannot detect or prevent the duplicate. The workflow author
must make steps idempotent (mvp spec §5.6, `docs/research/resume-side-effect-contract.md`).

Or serve it over HTTP and watch it in the viewer:

```bash
pnpm --filter @path/viewer run build               # path-server serves dist/, so build it first
pnpm --filter @path/designer run build             # path-server also serves the designer bundle
npx tsx packages/server/bin/path-server.ts . --port 8080   # v0 API + the built viewer + /designer/
pnpm --filter @path/viewer run dev                 # or: viewer dev server, proxies API calls
pnpm --filter @path/designer run dev               # or: designer dev server, proxies API calls
```

`path-server` mounts the viewer at `/` and the designer at `/designer/`. An unbuilt bundle serves
nothing (its routes 404), so build each bundle you want to serve first.

The bins are TypeScript entry points. `tsx` runs them. There is no build step. There is no linked
`path` or `path-server` on your `PATH`. Thus `pnpm exec path-server` cannot find them.

The first argument to `path-server` is the project directory. The server reads and writes `.path/`
there. This argument defaults to the current directory. The engine CLI is different: it finds its
project directory from the workflow file location.

## Status (2026-09-20)

The latest release is **v0.6.3** (2026-09-20). `CHANGELOG.md` covers the history through v0.5.4; from
v0.6.0 on, each release's notes live on the GitHub releases page. The **Designer** has shipped, the
**person-activity** step type shipped in v0.6.3, and the workflow format is `path/workflow@4`. The
`main` branch is green. `pnpm -r run typecheck` is clean across all packages. 2160 tests pass: schema
350, engine 832, server 238, designer 349, viewer 169, client-core 194, scripts 28.

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
  `path/workflow@1` collapse into one uniform node shape. A new `sequence` controller carries the
  multi-step case. That case used to hide in a bare node array (ADR 0014). A parallel branch is now a
  node. The branch arm, `else`, and `while-do` slots each hold one `node`. The new format is
  `path/workflow@2`. It is clean-slate and codemod-migrated. The codemod
  `scripts/migrate-workflow-format-v2.ts` fills once and is idempotent. There is no DB break. Two
  Opus 5 refactors are included (#290). `loadWorkflowTree` returns a `LoadedWorkflow`. Both launch
  routes collapse behind one `prepareWorkflow`.
- **v0.5.2** — the viewer's left rail grows up. One flat file list becomes two panes: Workflows (the
  catalog you can launch) and Runs (the ledger you have launched), each run stamped with the workflow
  it came from. The Workflows pane filters by kind (`all` / `root` / `nested` / `invalid`); an invalid
  file folds its parse error away. A per-run delete affordance lands, backed by a new
  `DELETE /v0/runs/:root_run_id` that removes the run from both stores, guarded against a running root
  and a live successor's reuse reference (`409`, `?force=true` to override). No format or DB break.
- **v0.5.3** — resume keeps its receipts. A resumed run's reused node is now a real **reuse row** — a
  `succeeded` run row of its own, not just a log marker — so it shows in the run tree and a chained
  resume can reuse it straight from `runs` (#257). The audit read path gets three named concepts: a run
  **kind** (`runKind`, `isRootRun`, `isReuseRow`), a shared **run tree** primitive in `@path/schema`,
  and one domain `RunRecord` the client's live state collapses onto. Each leaf step also snapshots its
  context, so the NODE I/O/C panel follows the blackboard step by step (#297). No format or DB break.
- **v0.5.4** — a leaf step type stops being hardcoded. The two built-ins, `binary` and `prompt`, leave
  the closed node union and become the first two **plugins** under `packages/engine/step-plugins/`,
  each importing the public `@path/engine/plugin` seam a third-party plugin would use (ADR 0018–0024).
  The engine discovers, validates, and dispatches every leaf step through one registry scanned once per
  run. The `engine | llm` worker union is gone: `worker` is now an optional worker-name string, the
  format is `path/workflow@3` (codemod `scripts/migrate-workflow-format-v3.ts`), and the per-Processor
  concurrency cap is renamed from `llm` to `processor` (#331). A `prompt` step now fails on an Agent SDK
  `is_error` result instead of passing the error text downstream as output (#349). This release breaks
  both the format (`@2` to `@3`) and the DB (`SCHEMA_VERSION` 7, clean-slate).
- **v0.6.0** — the Designer arrives (map #254, ADR 0027–0031). A new `@path/designer` bundle, served at
  `/designer/` beside the viewer's `/viewer/`, authors a workflow file on a node canvas: open and render
  read-only (#367), edit the tree (#368), edit the selected node or the file through a properties pane
  (#369, #399), author `$env` / `$secret` config values (#387), undo/redo with a clean/dirty baseline
  (#389), and mark cross-node and dangling-ref problems (#388, #391). Its run dock mounts the viewer's
  own `RunsList │ RunDetail │ NodeIo` panels over a shared run-logic seam moved into `@path/client-core`
  (#359, #372), so a run reads identically on both surfaces. Both surfaces drag-resize their panels. The
  server serves the two bundles from named mounts and adds the authoring routes: raw file read, the
  `PUT /v0/workflows` write, the `GET /v0/step-plugins` registry, edit-lock leases, and `workflow_id`-
  filtered runs (#360–#365). The toolchain moves to **Node 24** to match CI. No format or DB break.
- **v0.6.1** — the authoring surface gets its polish pass. The properties pane lines each datum up on one
  aligned row against a shared label column, with infix leaf conditions and lowercase labels (#405,
  #407). New authoring affordances land: a bare whole-string input, nested workflow-refs by double-click,
  an interpolable while-do max-iterations, Tab to fill a placeholder in, and a prompt's inherited model
  shown as a ghost with override and revert (#407). The viewer's workflows list becomes a navigable
  folder tree that the Designer's open picker reuses, and the node I/O panel shows provenance lines for
  the Context and Error blocks (#406). Rail resize gets robustness fixes (#404), and the properties pane
  is refactored behind one draft-validate-commit seam and one keyed-row-editor seam (#409, #410). No
  format or DB break.
- **v0.6.2** — resume grows from "restart the failed run" into **Resume-from-chosen-K** (ADR 0033–0037).
  A run id names the rerun boundary K: a top-level node, or a node inside a nested `workflow` file,
  reached by a per-level descent path. Every node before K reuses its succeeded result; K and the nodes
  after it re-run. Plain resume is K at the auto-boundary. The CLI gains `--from <run-id>` and the
  `--list-eligible` dry run, the Designer its "Resume from …" run-tree button, and the viewer one
  resume-action card with inline reasons. One eager legality predicate keeps the Designer's preview and
  the engine's verdict in step. A `while-do` iteration now runs in its own run scope, so a completed
  loop body reuses on resume. No format or DB break.
- **v0.6.3** — a step can wait for a person. The new **person-activity** step type parks a run in the
  leaf-only `awaiting` status, and a durable **Complete** re-invokes the engine over the appendable tree,
  so an offline decision resumes the tree where it stopped (#462–#496, ADR 0038–0043). Worker choice
  becomes a four-tier resolution — `node.worker`, a launch worker-default, the file's `worker_defaults`
  table, then the plugin default — and the format cuts over to `path/workflow@4` (codemod
  `scripts/migrate-workflow-format-v4.ts`). The launch's operator facts (`input`, `config`, and worker
  defaults) are frozen with the run, a file can seed a default `input`, and the `prompt` step type gains
  a `deepseek` worker while its Agent SDK worker is renamed `sdk` to `anthropic`. This release breaks the
  format (`@3` to `@4`) and the DB (`SCHEMA_VERSION` 9 to 12, clean-slate).

### What's next

- No product gap is open. #110, replaying a run's narrative from `log_events` when the `ndjson` backend
  is off, shipped and is closed. The step surface now grows by plugin folder rather than by engine
  change, so the open plugin requests are a person-switch controller (#477) and a GOTO controller
  (#478). A step template (#459) and a workflow template (#460) ask for authoring reuse, and a project
  web site is tracked as #458.
- #109 the **v-next register** — a promotion trigger for each deferred door in mvp spec §10. This
  stays open. Each door moves into its own wayfinder map when its trigger fires. `$env` (v0.4.3) and
  resume (v0.4.4) have shipped. The step-plugin seam (v0.5.4) is now the vehicle for the deferred step
  types: an API-endpoint step type can ship as a plugin folder rather than a core union member.
  Automatic in-run retry is still deferred.
- The **Designer** has shipped (map #254, ADR 0015–0017, 0027–0031). It cut into a release as v0.6.0 and
  got its polish pass in v0.6.1 (see the release timeline above). `@path/designer` is a buildable bundle
  `path-server` serves at `/designer/`. Map #254 is now the vehicle for further authoring work rather
  than an unreleased track.

## Maintenance notes

- The warmed sandcastle store is a snapshot of today's lockfile. If agents add dependencies,
  `pnpm install` in the sandbox downloads only the new packages. This is still fine. But the lockfile
  can drift a lot over time. If it does, rebuild the image to re-warm it:
  `pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`.
- The "limit hit mid-merge" failure can happen again on long cycles. If it does, use the same
  recovery. Check `git status` for a half-finished merge before you run the loop again.
