# Release Notes

This release adds file-level and launch-level workflow input and worker defaults, improves Designer and Viewer workflows, expands credential handling, and includes reliability fixes plus internal refactors. Workflow files move to `path/workflow@4`, and several dependency upgrades may affect local tooling or plugin development environments.

## Features

### Workflow input and worker defaults

- **File-level workflow input** — Workflow files can define an optional top-level `input` object as the default root context seed. Launch input now acts as an override: if it is non-empty, it wins; if it is blank, `{}`, or omitted, the file seed is used, then `{}`. HTTP launches resolve and record the effective input server-side, and Designer file properties now include an input editor.
- **File worker defaults** — Workflow files can declare top-level `worker_defaults` to choose workers for un-pinned steps by type. In the final four-tier resolution, dispatch is `node.worker ?? launchWorkerDefaults[type] ?? file.worker_defaults[type] ?? plugin.defaultWorker`. The workflow format moves to `path/workflow@4`.
- **Launch worker defaults** — Operators can supply run-wide launch worker defaults via repeatable CLI `--worker-default <type>=<name>`, `worker_defaults` on `POST /v0/runs`, the Viewer launch panel, and the Designer run dock. Launch defaults sit below explicit node worker pins and above file defaults. The CLI refuses `--worker-default` together with `--resume`, since launch worker defaults are fixed at launch.
- **Worker-default validation** — File-level `worker_defaults` are validated against the installed registry at file load. Launch worker defaults are validated at the launch boundary before the run starts: the CLI exits with code 2 and the server returns 400 on invalid values.
- **Frozen launch facts** — The run root records the operator’s launch input override, config override, and launch worker-default table. Resume/Complete recover the frozen config and worker table; supplied config merges over frozen config. Masked secrets are stored as tokens and re-entered in Viewer Complete/Resume forms. The Viewer run pane shows these three facts for root runs, and the launch worker-default table stays frozen across continuations.

### Designer and Viewer

- **File-level Reference section in Designer** — The properties pane now lists referenceable file-level paths (`config.` / `context.`) at the end of file properties, mirroring the node-level Reference section.
- **Collapsible Designer properties pane** — Node/file properties are grouped into collapsible sections for kind fields, config, input, context writes, reference, file config, worker defaults, and output. For a node, `name` and `id` remain at the pane root rather than inside an identity section. Payload regions start collapsed, expansion resets with selection, and node `name`/`id` remain visible at the pane root.
- **Viewer launch form improvements** — The Viewer launch panel supports launch worker-defaults and separates input JSON and config override behind their own disclosures.
- **Resumed-run input provenance in Viewer** — For a successor root created by Resume, the node I/O Input block now shows the predecessor root’s actual input and names the resumed-from root run/blob instead of showing the successor’s empty seed.

### Credentials

- **DeepSeek credential config-first** — The `deepseek` worker reads `DEEPSEEK_API_KEY` from config first, allowing launch-time `$secret` or literal config values, with `process.env.DEEPSEEK_API_KEY` as the fallback.

## Fixes

- **Designer canvas breadcrumb** — The root crumb is now badged from the root’s `displayStatus`, falling back to raw status before the root row lands. An awaiting leaf under a running root now reads `awaiting` consistently with the runs list, run-detail head, run tree, and node pane.
- **Viewer Complete form secret validation** — A recorded launch secret path is treated as blank when its value is missing, not a string, or whitespace-only. The form names each bad path, disables Complete, and re-checks on submit so no request spends the wrong credential.
- **Server Complete workflow identity check** — Server Complete now uses shared `prepareRunWorkflow` to recover the run’s workflow, apply the launch gate, and verify workflow identity. It refuses a swapped file even when node ids/types match.
- **Plugin leaf step handling** — Schema/engine step-ness is derived from the controller set instead of an allowlist, so installed plugin leaf types are not skipped by reuse, rerun, or legal-K flows.
- **Engine observation logging** — Engine observations now carry their own `nodeId`/`nodeName`, fixing null or mislabeled logging records during Complete replay.
- **Engine cancellation causes** — Engine cancellation has a single root/block authority and a single stopped-cause read, removing contradictory `run-cancelled` causes.

## Details

### Internal improvements

- **Engine refactors** — Single run-walk owner (`NodeExecContext.walk`) removing the executor↔parallel import cycle; centralized node disposition; centralized effective-config merge/unwrap; centralized cancellation; observation node stamping.
- **Schema/server/client-core refactors** — Publish-set rule returned as data from one owner; shared `prepareRunWorkflow`; run-view snapshot publishes `displayStatus`, `lastError`, and `awaitingRunIds`.
- **Designer refactors** — One discovery load for workflows; reducer owns staleness/descend/reload/save doors; `EditKey` replaces ad-hoc coalesce/key strings for undo and draft reseeding.
- **Tests** — Enabled vitest transform caching for schema and client-core; reused workers across files, reduced jsdom setup, raised timeout to 20s, and fixed the engine `do-not-wait` kill-mid-flight race; fixed fixture drift for the Designer dock registry and scripts codemod deepseek.
- **Tooling/dependencies** — Bumped `@types/node` to `^26`; upgraded React 18→19, Vite 5→8, Vitest 2→5, jsdom 25→30, `@types/better-sqlite3` 7→9; migrated zod 3→4; upgraded TypeScript 5.7→7.0.2 with safe dependency bumps.
- **Workflow file chores** — Reordered w2 person-activity node keys to canonical order; normalized w1 field order.

### Upgrade notes

- Workflow files now use format `path/workflow@4`.
- Dependency upgrades may require updating local tooling or plugin development environments, especially React 19, Vite 8, Vitest 5, jsdom 30, zod 4, and TypeScript 7.0.2.
- Plugin and worker authors should note that step-ness is now derived from the controller set rather than an allowlist.