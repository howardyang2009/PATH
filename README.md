# PATH

[![CI](https://github.com/howardyang2009/PATH/actions/workflows/ci.yml/badge.svg)](https://github.com/howardyang2009/PATH/actions/workflows/ci.yml)
[![workflow format](https://img.shields.io/badge/format-path%2Fworkflow%405-blue)](docs/format/workflow-format-v5.md)
[![latest release](https://img.shields.io/github/v/release/howardyang2009/PATH)](https://github.com/howardyang2009/PATH/releases)

PATH runs workflows that can stop and start again. You describe a workflow as JSON: **steps** do the
work, **controllers** route it, and **workers** decide *how* each step runs. Run it on your machine or
over HTTP. Watch, launch, resume, and complete runs in the browser. Author files on a visual canvas.

The part that makes PATH different is what happens when work stops:

- **Resume with receipts.** A crashed or cancelled tree re-runs as a *successor*. Every node that
  already succeeded is reused, not repeated — or you pick the boundary yourself with `--from`.
- **Humans are steps.** A `person-activity` step parks its run in the leaf-only `awaiting` status.
  Somebody presses **Complete** an hour or a week later, and the run continues from that point.

## Why PATH

- **JSON, not YAML.** One strict schema (`path/workflow@5`) validates a file before anything runs.
  Unknown fields are errors, not surprises.
- **Durable by default.** Every run writes structured rows to SQLite and blobs to a per-project
  `.path/` directory. A crash costs you the unfinished nodes, nothing more.
- **Swap the *how*, keep the *what*.** A step's `worker` is a name, not a code path. The same `prompt`
  step runs on `anthropic` or `deepseek`; `binary` runs on `spawn`. Selection is per step, per
  worker-default, or per launch.
- **Open step types.** A leaf step type is a folder under `packages/engine/step-plugins/` that imports
  the public `@path/engine/plugin` seam. `binary`, `prompt`, and `person-activity` are peers, not
  special cases.
- **Two consoles over one client.** The **viewer** monitors, launches, resumes, and completes runs.
  The **designer** authors files on a node canvas. Both sit on the shared `@path/client-core` API.

## Quick start

PATH needs **Node 24 or later** and **pnpm 12** (the repo pins `pnpm@12.5.1` through `packageManager`;
`corepack enable` is the easy way to get it).

```bash
pnpm install
pnpm typecheck
pnpm test
```

### Run a workflow

Save the [example below](#a-workflow-file) as `hello.workflow.json`, then run it with the engine CLI:

```bash
pnpm path run hello.workflow.json
# {"greeting":"hello world"}
```

`pnpm path` is a shortcut for `tsx packages/engine/bin/path.ts`. The bin is a TypeScript entry point;
there is no build step and no linked `path` on your `PATH`.

### Watch it in the browser

```bash
pnpm serve
```

This builds both consoles and starts `path-server` on <http://localhost:8080>. The viewer lives at
`/viewer/` (bare `/` redirects there), and the designer at `/designer/`. For UI work, run
`pnpm --filter @path/viewer run dev` or `pnpm --filter @path/designer run dev` instead; each dev
server proxies API calls to a running `path-server`.

## A workflow file

```json
{
  "format": "path/workflow@5",
  "id": "d82c9ac6-7abb-46f7-8849-98eb4c590f8f",
  "name": "hello",
  "body": [
    {
      "type": "binary",
      "id": "8e8cbe71-8b7e-48fb-be34-828c07bb503f",
      "name": "greet",
      "command": "node",
      "args": ["-e", "process.stdout.write(JSON.stringify({ greeting: \"hello world\" }))"],
      "parse": "json",
      "publish": { "greeting": "${output.greeting}" }
    },
    {
      "type": "checkpoint",
      "id": "b0355228-5848-43be-8648-d81f7bfe4df0",
      "name": "greeting-exists",
      "condition": { "type": "matches", "path": "context.greeting", "pattern": "^hello" }
    }
  ],
  "output": { "greeting": "${context.greeting}" }
}
```

A file has a `format`, a durable `id`, a `name`, and a non-empty `body` array of **nodes**. Every node
carries a durable `id` and a file-unique `name`. Optional top-level keys are `config`, `input`,
`worker_defaults`, and `output`.

`greet` is a `binary` step: the engine writes the step's input object to the process's stdin and reads
the output from stdout. `parse: "json"` turns that stdout string into a structured value, and `publish`
writes it into the run's context under `greeting`. The `checkpoint` then asserts that context key. If
the assertion fails, the run stops as failed and the failure propagates like any other.

**Input.** A launch seeds the root context. Every launch door resolves one rule: a launch `input`
override with at least one top-level key wins; otherwise the file's own top-level `input` is the default
seed; otherwise `{}`. On the CLI the override is `--context <file>` or `--set-context key=value`; over
HTTP it is the `input` field, which both consoles send. A nested `workflow` step's run gets its context
from the parent step's input, never from the child file's `input`.

**Interpolation.** `${dot.path}` reads `config` and `context` in payload fields, `input` values,
`publish` values, workflow `output` values, and `max_iterations`. A string that is exactly one
placeholder keeps the referenced value's real type; otherwise values splice into text. Unresolvable
paths are errors.

## Core concepts

The full glossary is [`CONTEXT.md`](CONTEXT.md). These are the terms every other page uses.

| Term | Meaning |
| --- | --- |
| **Step** | The unit of work. One input object, one output object. A step says *what* to do. |
| **Worker** | *How* a step type produces its output: a named `run` method the type ships. `binary` ships `spawn`; `prompt` ships `anthropic` and `deepseek`; `person-activity` ships `person`. |
| **Task** | A step bound to a worker. `task = step + worker`. |
| **Run** | One executing or executed instance of a task. The only execution term in PATH. Statuses: `pending`, `running`, `awaiting`, `succeeded`, `failed`, `cancelled`. |
| **Controller** | An engine-evaluated construct with no worker and no run: `sequence`, `parallel`, `branch`, `while-do`, `checkpoint`, `goto`. |
| **Config vs context** | `config` is authored, inherited, and evaluated before a run (`${config.x}`). `context` is produced by the run itself (`${context.x}`). |
| **Node** | Any element of a `body` or a single-`node` slot: a step or a controller. |

Every workflow node type is a member of one flat union discriminated by `type`:

| `type` | Kind | Fields |
| --- | --- | --- |
| `binary` | step | `command`, `args?`, `cwd?` |
| `prompt` | step | `prompt` |
| `person-activity` | step | `description`, `outputSchema?`, `assignee?` |
| `workflow` | step | `ref` |
| `sequence` | controller | `body` |
| `parallel` | controller | `join` (`collect` / `wait-one` / `do-not-wait`), `branches` |
| `branch` | controller | `arms`, `else?` |
| `while-do` | controller | `condition`, `max_iterations`, `node` |
| `checkpoint` | controller | `condition` |
| `goto` | controller | `target` (a first-level node name), `max_jumps` |

A `goto` moves the file's top-level walk to a named first-level node of its own file, backward or
forward. Reached again after `max_jumps` jumps, it fails the run instead of jumping. It may not sit
under a `while-do` or a `parallel`. Each stretch of the walk between jumps is a **pass** in the run
tree ([`docs/spec/goto.md`](docs/spec/goto.md)).

The engine-owned types are reserved. Every other `type` value is a plugin leaf type, so a file is valid
*against a registry*: the same bytes load in a tree that holds the plugin and fail in one that does not,
both correctly.

## Model steps

A `prompt` step sends its rendered prompt plus the step's input object to a model:

```json
{
  "type": "prompt",
  "id": "219caa5b-fad8-42cf-8e22-91e17eb99172",
  "name": "summarize",
  "prompt": "Summarize this diff in one paragraph.\n\n${context.diff}",
  "config": { "model": "sonnet" }
}
```

- `config.model` is required for a `prompt` step. A step without it fails at run start.
- The **worker** selects the provider: `anthropic` (default, Anthropic via the Agent SDK) or
  `deepseek` (one OpenAI-compatible Chat Completions request). Both get the same rendered message.
- The `deepseek` worker reads its credential from `config.DEEPSEEK_API_KEY` first and
  `process.env.DEEPSEEK_API_KEY` second. Its endpoint is environment-only: `DEEPSEEK_BASE_URL`.

## Human-in-the-loop steps

A `person-activity` step computes nothing. It parks the run until a person completes the offline work:

```json
{
  "type": "person-activity",
  "id": "5025fae4-3c8c-418b-86fc-d30c6ebc83d1",
  "name": "approve-release",
  "description": "Approve the release notes for ${config.repo}",
  "assignee": "release-ops",
  "outputSchema": {
    "type": "object",
    "required": ["approved"],
    "properties": { "approved": { "type": "boolean" } }
  },
  "publish": { "approval": "${output}" }
}
```

The step's `person` worker returns `{ status: "awaiting" }` and the engine tears the run down cleanly.
The wait is durable: it survives restarts and deploys. When the person is done, Complete submits the
output. The engine validates it against `outputSchema` (Ajv, from the current file), writes it as the
leaf's output, moves the leaf to `succeeded`, and continues the run.

`awaiting` is **leaf-only**. A parent run stays `running` while a descendant awaits, and a surface that
wants to signal "nothing is executing" derives that from the child rows. A person-activity branch inside
a `parallel` join behaves like any other branch: `wait-one` can cancel it, and its later Complete lands
`409`.

## Choosing a worker

A step's worker resolves through four tiers, first hit wins:

1. `node.worker` — the step's own pin.
2. **Launch worker-default** — supplied by the operator, run-wide, and frozen with the run.
3. **File worker-default** — the file's top-level `worker_defaults` table, file-scoped and live.
4. The step type's `defaultWorker` — `spawn`, `anthropic`, or `person`.

```jsonc
{
  "worker_defaults": { "prompt": "deepseek" }   // this file's prompt steps now run on deepseek
}
```

Launch defaults come from `--worker-default <type>=<name>` on the CLI or a top-level `worker_defaults`
table on `POST /v0/runs`. The Designer run dock and the viewer launch panel both offer an editor. A
launch default is validated at the launch boundary (the CLI exits non-zero, the server returns `400`); a
file table is validated against the registry at load, so a bad table makes the file invalid.

Because a launch worker-default is identity-defining like `input`, it is frozen with the run.
`--worker-default` is refused with `--resume`: changing it is a new run, not a resume.

## Resume, and where it starts

```bash
pnpm path run hello.workflow.json --resume <root-run-id>
pnpm path run hello.workflow.json --resume <root-run-id> --list-eligible
pnpm path run hello.workflow.json --resume <root-run-id> --from <run-id>
```

- **`--resume`** re-runs a stopped tree as a *successor*. It reuses every node that already succeeded
  and re-runs the rest.
- **`--list-eligible`** prints the candidate rerun boundaries and launches nothing.
- **`--from <run-id>`** picks boundary K: every node before K reuses its result, K and everything after
  it re-runs. K may be a top-level node or a node inside a nested `workflow` file. Plain `--resume` is
  just K at the automatic boundary.

> **Resume is at-least-once.** A re-run step can fire an external effect a second time — a `git push`,
> an API `POST`. The engine cannot detect or prevent the duplicate. Make steps idempotent. See mvp spec
> §5.6 and [`docs/research/resume-side-effect-contract.md`](docs/research/resume-side-effect-contract.md).

## CLI reference

```bash
pnpm path run <workflow.json> [flags]
pnpm path runs [-C <dir>] [--limit <n>] [--status <status>] [--workflow <name>]
pnpm path runs rm [--force] <root-run-id>
pnpm path runs prune [--yes]
```

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `-C <dir>` | `run`, `runs` | Target another project's `.path/` store, git-style. |
| `--config <file>` | `run` | Operator config override, merged over the file's `config`. |
| `--set key=value` | `run` | One config override. Repeatable. |
| `--context <file>` | `run` | Root context seed for a fresh run; overrides the file's `input`. |
| `--set-context key=value` | `run` | One context seed entry. Repeatable. |
| `--worker-default type=name` | `run` | Launch worker-default. Repeatable; refused with `--resume`. |
| `--resume <root-run-id>` | `run` | Re-run a stopped tree as a successor. |
| `--from <run-id>` / `--list-eligible` | `run` | Choose, or list, the rerun boundary K. Requires `--resume`. |
| `--log-backends db,ndjson` | `run` | Turn event backends on or off (`none` means all off). |
| `--processor-concurrency <n>` | `run` | Engine-wide live-worker cap. |

Engine-level defaults also live in `.path/settings.json` (`log.backends`, `processor.concurrency`).
Nearest wins: CLI flag, then settings file, then the built-in default. The engine writes
`.path/path.db` (SQLite), `.path/runs/<root-run-id>/` (blobs and `run.log`), and reads `.path/` beside
the workflow files, like `.git`.

## HTTP API and consoles

`path-server` serves the v0 API, the viewer, and the designer from one process. Its first argument is
the project directory and defaults to the current directory.

| Route | Purpose |
| --- | --- |
| `POST /v0/runs` | Start a run (`workflow_path`, `input`, `config`, `worker_defaults`). |
| `GET /v0/runs` | List root runs, with `limit`, `status`, and `workflow_id` filters. |
| `GET /v0/runs/:root_run_id` | One run's status and full run tree, including frozen launch facts. |
| `GET /v0/runs/:root_run_id/events` | SSE stream: persisted history first, then live events. |
| `GET /v0/runs/:root_run_id/blobs/:run_id/:name` | A run's `input.json`, `output.json`, or `context.json`. |
| `POST /v0/runs/:root_run_id/cancel` | Cancel a root run in flight. |
| `POST /v0/runs/:root_run_id/resume` | Resume, optionally at a chosen boundary K. |
| `POST /v0/runs/:step_run_id/complete` | Complete an awaiting step with `output`. |
| `DELETE /v0/runs/:root_run_id` | Remove a run from both stores. |
| `GET /v0/workflows`, `GET /v0/workflows/file`, `PUT /v0/workflows` | Discover, read, and write workflow files. |
| `GET /v0/step-plugins` | The step-type registry the designer authors against. |

Every mutating route sits behind a CSRF/origin gate. The server is a no-auth, localhost-bind,
single-origin tool: do not expose it.

## Packages

| Package | What it is |
| --- | --- |
| [`@path/schema`](packages/schema) | The domain. The workflow format (`path/workflow@5`), the registry factory that opens its node union to plugin step types, and the runtime vocabulary: run status, log events, traces, and the v0 wire shapes. |
| [`@path/engine`](packages/engine) | Runs workflows locally and provides the `path` CLI. Discovers leaf step types as plugins under `step-plugins/` and exposes the `@path/engine/plugin` seam. |
| [`@path/server`](packages/server) | The HTTP and SSE API over the engine, plus the `path-server` CLI that serves both consoles. |
| [`@path/client-core`](packages/client-core) | A pure-TypeScript API client: SSE client, run view-model, and run/workflow write surface. No framework, no Node. |
| [`@path/viewer`](packages/viewer) | The React run console. Monitors runs live, and launches, resumes, and completes them. |
| [`@path/designer`](packages/designer) | The React authoring console. Opens, edits, and saves workflow files on a live canvas. A peer of the viewer, never an importer of it. |

## Development

```bash
pnpm install          # install the workspace
pnpm typecheck        # tsc --noEmit in every package
pnpm test             # vitest in every package
pnpm serve            # build both consoles and serve everything on :8080
pnpm release-notes    # dogfood: PATH summarizes its own recent commits
```

- `main` is protected. Changes land through a pull request whose CI `test` job is green. A local
  pre-commit hook refuses a direct commit on `main` (`ALLOW_COMMIT_ON_MAIN=1` overrides once).
- The CI workflow runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm test` on Node 24.
- Source is TypeScript only; there is no build step for the engine or server bins.

## Documentation map

| Document | Covers |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The canonical glossary. Read this first. |
| [`docs/format/workflow-format-v5.md`](docs/format/workflow-format-v5.md) | The normative workflow file format (a delta over v4 and v3). |
| [`docs/spec/mvp-spec.md`](docs/spec/mvp-spec.md) | Execution semantics: scheduling, data flow, persistence. |
| [`docs/spec/person-activity.md`](docs/spec/person-activity.md) | `awaiting`, Complete, and `outputSchema` validation. |
| [`docs/spec/resume-from-k.md`](docs/spec/resume-from-k.md) | Choosing the rerun boundary K. |
| [`docs/api/server-api-v0.md`](docs/api/server-api-v0.md) | Every HTTP route and its wire shapes. |
| [`docs/adr/`](docs/adr) | Architecture decision records. |
| [`docs/agents/`](docs/agents) | How agents work in this repo. |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history through v0.5.4. |

## Status

The latest release is **v0.6.3** (2026-09-20). The workflow format is `path/workflow@4` and the store
schema is `SCHEMA_VERSION` 12. `main` is green: `pnpm typecheck` is clean across all packages and
**2162 tests pass** — schema 354, engine 834, server 234, designer 349, viewer 169, client-core 194,
scripts 28.

The MVP is done, and all three wayfinder maps are closed: #1 spec, #29 server API, and #40 viewer. No
product gap is open. Built on `main`, unreleased: authoring reuse (Templates #459; the
Workflow-Template #460 was removed by ADR 0063), the person-switch template #477, and the goto Graph
Controller #478. Work
continues on the
[#109 v-next register](https://github.com/howardyang2009/PATH/issues/109).

| Release | Date | Headline |
| --- | --- | --- |
| v0.6.3 | 2026-09-20 | `person-activity` + `awaiting`, durable Complete, four-tier worker defaults, format `@4`. |
| v0.6.2 | 2026-09-09 | Resume-from-chosen-K (`--from`, `--list-eligible`), per-iteration `while-do` scopes. |
| v0.6.1 | 2026-09-04 | Designer polish: aligned properties pane, new authoring affordances. |
| v0.6.0 | 2026-09-03 | The Designer: author workflow files on a live canvas. |
| v0.5.4 | 2026-08-30 | Leaf step types become plugins; format `@3`; DB break. |
| v0.5.3 | 2026-08-23 | Reuse rows; run kind; per-step context snapshots. |
| v0.5.2 | 2026-08-21 | Viewer rail splits into Workflows and Runs; run delete. |
| v0.5.1 | 2026-08-20 | One uniform node shape; format `@2`. |
| v0.5.0 | 2026-08-16 | Parallel joins (`wait-one`, `do-not-wait`) and a console that launches. |
| v0.4.4 | 2026-08-08 | Resume: re-run a stopped tree as a successor. |
| v0.4.3 | 2026-08-02 | `$env` config sourcing. |
| v0.4.1 | 2026-07-27 | Interior seams; architecture review pass. |
| v0.4.0 | 2026-07-26 | Cancellation. |

Full notes live on the [releases page](https://github.com/howardyang2009/PATH/releases); the
[`CHANGELOG.md`](CHANGELOG.md) covers v0.1.0 through v0.5.4.

## Notes for maintainers and agents

- [`CLAUDE.md`](CLAUDE.md) lists the agent skills this repo uses; [`docs/agents/`](docs/agents) explains
  the issue tracker (`gh`, repo `howardyang2009/PATH`) and the domain-doc layout.
- Vocabulary in code, specs, and issues follows `CONTEXT.md` exactly. If you introduce a term, define it
  there first.
- **`.sandcastle/` is not part of the product.** It is the maintainers' own agent loop — a planner, one
  implementer and one reviewer per ready issue, then a merger — driven by `pnpm sandcastle` and the
  root devDependency `@ai-hero/sandcastle`. Nothing in `packages/` imports it, no test runs it, and a
  contributor working on PATH itself can ignore it.
- The warmed sandcastle store is a snapshot of the current lockfile. New dependencies download
  incrementally, which is fine, but the lockfile drifts over time. Re-warm the image when it does:
  `pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile`.
- A long merge cycle can hit "limit hit mid-merge". Check `git status` for a half-finished merge before
  restarting the loop.
- Only the current workflow-format codemod lives at the top of [`scripts/`](scripts); the superseded
  ones sit in [`scripts/archive/`](scripts/archive) and stay runnable, because
  `SUPERSEDED_FORMAT_VERSIONS` points a file still carrying an older format string at them.
