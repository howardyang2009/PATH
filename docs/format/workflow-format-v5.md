# PATH Workflow File Format v5

This is the normative definition of `path/workflow@5`. `@path/schema` implements it as zod schemas. The
engine executes it. The vocabulary follows [CONTEXT.md](../../CONTEXT.md) (step, worker, task, run,
controller, checkpoint, config vs context, output object, publish, first level).

`@5` is `@4` plus **one** grammar change: the `goto` controller, which lands in a later build ticket
(§1). Everything else — the envelope (`worker_defaults`, `input`), every other node type, config vs context, `publish`, `output`,
interpolation, the worker-name model — is exactly as [`workflow-format-v4.md`](workflow-format-v4.md)
and [`workflow-format-v3.md`](workflow-format-v3.md) state it. Those documents remain the full
normative reference for all of it; this one states only the delta, matching how `@4` treated `@3`.

## 0. What `@5` is

`@5` adds a seventh reserved member, `goto`, to the node union (ADR 0058). The version bumps because
the node grammar changed, per the format-versioning rule (#501): an engine that reads `@4` does not
know `goto`, so a file that may carry one must say so in `format`, where an older engine refuses it
legibly (§3) rather than at an unknown node deep in the body.

The envelope does not change. A goto-free `@4` file is already a valid `@5` file once its `format`
string moves.

```jsonc
{
  "format": "path/workflow@5",
  "id": "…",
  "name": "…",
  "body": [ /* … */ ]
}
```

Step-Templates and Workflow-Templates stamp the same `FORMAT_VERSION` (ADR 0048 §1), so they read
`path/workflow@5` too.

## 1. `goto`

> [!NOTE]
> The format version moved first (#621) so the goto build tickets land on a stable format. Until those
> tickets ship, the schema does not accept a `goto` node yet, and a `@5` file is shape-for-shape a `@4`
> file.

The node is `{ "type": "goto", "id", "name", "target", "max_jumps" }`: `target` names a first-level
node of the same file, and `max_jumps` bounds how often the jump is taken. Its placement rules, load
refusals and execution are specified normatively in [`docs/spec/goto.md`](../spec/goto.md) §2–§3
(ADRs 0053–0061). This section gains the full grammar when the node lands.

## 2. Migration from `@4`

`@4` and `@5` differ only by the `format` string for every file that exists today, so the `@4` → `@5`
codemod is a **no-op format stamp**: it rewrites `format` to `path/workflow@5`, changes nothing else
(the file's bytes, formatting included, are carried through), refuses nothing, and is idempotent. Run
it with:

```
pnpm tsx scripts/migrate-workflow-format-v5.ts [file …]
```

With no arguments it discovers every `*.workflow.json`, `*.step-template.json` and
`*.workflow-template.json` under the current directory (skipping dot directories and `node_modules`)
and under its `.path/template/`. The engine reads `@5` only — there is no dual reader — so a `@4` file
loads with a targeted "run the codemod" error naming this script, not a generic schema error. An older
file names its whole codemod chain in order, ending with this script.

## 3. A newer version

The version pre-check is symmetric. A well-formed `path/workflow@<n>` with `n` greater than the
engine's own version gets:

```
path/workflow@6 is newer than this engine reads (path/workflow@5) — upgrade PATH to read it
```

rather than a bare invalid-literal on `format`. A malformed version string (a trailing space, a
non-numeric or zero-padded version, a different prefix) still falls through to the literal mismatch.
