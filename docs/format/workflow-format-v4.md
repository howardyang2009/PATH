# PATH Workflow File Format v4

> **Superseded by [`workflow-format-v5.md`](workflow-format-v5.md).** `path/workflow@4` is no longer
> read by the engine — `@5` is the format the `goto` controller lands in (ADR 0058). This document is
> retained because the CHANGELOG and closed issues link it, and it remains the normative reference for
> the `worker_defaults` and `input` envelope keys `@5` did not change; migrate `@4` files with
> [`scripts/migrate-workflow-format-v5.ts`](../../scripts/migrate-workflow-format-v5.ts).

This is the normative definition of `path/workflow@4`. `@path/schema` implements it as zod schemas. The
engine executes it. The vocabulary follows [CONTEXT.md](../../CONTEXT.md) (step, worker, task, run,
controller, checkpoint, config vs context, output object, publish).

`@4` is `@3` plus **one** new file-level field. Everything else — every node type, config vs context,
`publish`, `output`, interpolation, the worker-name model — is exactly as
[`workflow-format-v3.md`](workflow-format-v3.md) states it. That document remains the full normative
reference for all of it; this one states only the delta, matching how `@3` treated `@2`. `@3` is
retained because the CHANGELOG and closed issues link it.

## 0. What `@4` is

`@4` adds one change to the format and nothing else: a file may carry a top-level **`worker_defaults`**
table. The version bumps because the file envelope's grammar changed, per the format-versioning rule
(#501): a new envelope key is a format change even when it adds no new required data.

The file may also carry an optional top-level **`input`** object (§1a) — the file's default launch
seed. It is purely additive and optional, so a `@4` file written before it existed stays valid and the
format string does not move for it.

```jsonc
{
  "format": "path/workflow@4",
  "id": "…",
  "name": "…",
  "worker_defaults": { "prompt": "deepseek" },
  "input": { "ticket": 7 },
  "body": [ /* … */ ]
}
```

## 1. `worker_defaults`

`worker_defaults` is an **optional** `{ <stepType>: <workerName> }` map. It **selects**, per step type,
which worker that type's *un-pinned* steps run on in this file — a name chosen among the workers the
type already ships, never new code (ADR 0044, CONTEXT.md invariant 5).

Resolution order for a leaf step's worker, first hit wins:

```
node.worker  >  file worker_defaults[type]  >  plugin defaultWorker
```

- A step that names its own `worker` still wins — `worker_defaults` never overrides an explicit pin.
- A step of a type absent from the table falls back to the type's `defaultWorker`, unchanged.

It is **file-scoped**: it never crosses a `workflow`-ref boundary. A parent file's table does not reach
a child ref file's steps, and each ref file authors its own. It is **live**, not frozen: a resumed run
re-reads the current file, so an edit between launch and resume changes only re-run steps.

Its registry-relative validity (a real type shipping that worker) is checked at engine load, not by the
base file schema, which stays shape-only (`{ <string>: <string> }`).

## 1a. `input`

`input` is an **optional** JSON object: the file's own default seed for the root run's context. Its
top-level keys become the root context, exactly as a launch's `input` field does (§6.3 of
[`workflow-format-v0.md`](workflow-format-v0.md)).

```jsonc
{
  "input": { "ticket": 7, "labels": ["from-file"] }
}
```

It is **plain JSON data** — no `${…}` interpolation and no `$secret`/`$env` wrappers. Nothing resolves
the root seed before it lands in context, so a placeholder here would survive as literal text; the load
rejects one. It is a JSON **object**, never an array or a scalar, because its top-level keys are what
seed context.

Precedence at launch: an operator **input override** with at least one top-level key wins; a blank
field, a literal `{}`, or an omitted field falls back to this file seed; a file with no `input` falls
back to `{}`. The resolved value is what the run records.

It seeds the **root run only**. A nested `workflow`-ref run's context comes from its parent step's
`input`, never from the child file's own `input`.

## 2. Migration from `@3`

`@3` and `@4` differ only by the `format` string and the optional new key, so the `@3` → `@4` codemod
is a **no-op format stamp**: it rewrites `format` to `path/workflow@4`, changes nothing else, refuses
nothing, and is idempotent. Run it with:

```
pnpm tsx scripts/migrate-workflow-format-v4.ts [file …]
```

With no arguments it discovers every `*.workflow.json` under the repo root. The engine reads `@4` only —
there is no dual reader — so a `@3` file loads with a targeted "run the codemod" error naming this
script, not a generic schema error.
