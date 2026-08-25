# `path run -C <dir>` relocates the `.path` store only; it does not re-root the workflow path

Status: accepted

[#201](https://github.com/howardyang2009/PATH/issues/201) adds `-C <dir>` to `path run`, so that many
workflows can write their runs into one central directory instead of each dropping a `.path` beside its
own `workflow.json`. `path runs` already had a git-style `-C` (`extractDirFlag` at
`packages/engine/src/cli.ts`, "run as if started in `<dir>`"). This gives `run` the matching write-side
flag. The decision on the table was what `-C` should govern.

## Considered Options

- **git-style `-C` (re-root everything).** `path run docs/x.json -C foo` would resolve the workflow as
  `foo/docs/x.json` *and* write `foo/.path`, which mirrors `git -C`'s literal "as if started in `<dir>`"
  wording. Rejected: the `workflow.json` positional is a path the operator typed against their current
  directory. To silently re-root it under `-C` is the classic `git -C` gotcha, and it would break the
  common invocation `path run docs/x.json -C .` for any non-`.` dir.
- **Store-only `-C` (chosen).** `-C` sets where the `.path` store lands. The workflow positional still
  resolves against the real working directory. `path run docs/access-workflow/access-workflow.json -C .`
  reads `docs/access-workflow/access-workflow.json` and writes `./.path`.

## Decision

`path run -C <dir>` is **store-only**. It replaces the default project directory
(`dirname(workflow.json)`, at `packages/engine/src/cli.ts:318-319`) with `<dir>` for the purpose of a
locate of `.path` (path.db plus `runs/`), and nothing else. The `workflow.json` positional resolves
against the process working directory exactly as it does without `-C`. A missing `<dir>` is created
(`openProject`'s existing recursive mkdir). `-C` governs the whole command, including `--resume`: a
resumed run reads its predecessor from, and writes its successor into, the same relocated store.

The surface mirrors the existing `path runs` `-C`: a bare flag, no long form, accepted anywhere in
argv, and it reuses the `extractDirFlag` template.

## Consequences

- The documented "as if started in `<dir>`" framing of `path runs`' `-C` is now understood as
  store-location only. For the reader command there was never anything but the store to re-root, so
  `run` and `runs` stay consistent in effect while `run` deliberately does *not* adopt the chdir
  reading of that phrase.
- A central store filled by many workflows lists root runs by id alone: the `runs` table carries no
  source-workflow column (schema v3, `packages/engine/src/persistence/db.ts`). To persist and display
  workflow identity is deferred to its own issue, and it is additive to this decision, not a change to
  it.
