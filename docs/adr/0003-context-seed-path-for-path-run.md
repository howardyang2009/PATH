# `path run` gains `--context`/`--set-context`; combining either with `--resume` is a hard error

Status: accepted

[resume-door-verdict.md §3](../research/resume-door-verdict.md) found that root-level
`path run <file>` has no documented way to seed a file's starting `context`. It can seed only its
`config`, through `--config <file>` and `--set key=value`. This ticket
([#162](https://github.com/howardyang2009/PATH/issues/162), chartered by map
[#158](https://github.com/howardyang2009/PATH/issues/158)) closes that gap. It is **not** a `--resume`
mechanism: [resume-restore-semantics.md §1](../research/resume-restore-semantics.md) already settles
that a resumed run's context is restored **by load** from the original tree, automatic, no operator
input. This flag serves fresh (non-`--resume`) runs, chiefly to test one workflow step in isolation by
a seed of whatever prior context it expects to read through `${context.x}`.

## Considered Options

- **Overload `--set` with a `context.`-prefixed key** instead of new flags. Rejected: it routes two
  different destinations (`config` vs `context`) through one flag by a string-prefix convention. This
  is inconsistent with how `buildOperatorConfig` and `mergeConfig` already keep concerns separate
  elsewhere in the CLI.
- **`--input`/`--set-input` naming**, which matches the format doc's own term for the seed object
  (workflow-format-v0.md §6.3: "workflow's input object seeds context"; the nested `workflow` step's
  own field is literally `input`; `RunOptions.input` already exists engine-side in `run-workflow.ts`).
  Considered, not chosen. `--context`/`--set-context` was picked instead, which names the destination
  the operator is trying to affect rather than the spec's internal term for the seed object.
- **File-only flag, no per-key override.** Rejected: the testing use case is "tweak one context key,
  rerun." A fast `--set-context key=value` path beats an edit of a JSON file each iteration.
- **Declare and validate expected input keys in the workflow file itself** (workflow-format-v0.md §2's
  other named "possible additive extension"). Out of scope for this ticket. A `checkpoint` node already
  covers the testing use case's validation need (assert `${context.x}` is set, fail the run otherwise),
  so no schema change is required to unblock it.

## Decision

`path run <file>` gains:

- `--context <file>` — a whole JSON object, with the same validation `--config` already has (it must be
  a JSON object, error otherwise, forced by workflow-format-v0.md §6.3, which reads "top-level keys" of
  the seed).
- `--set-context key=value`, repeatable — with the same `JSON.parse`-or-raw-string-fallback as `--set`.

Both merge through the existing `mergeConfig` nearest-wins rule (the file loads first, `--set-context`
pairs override individual top-level keys), feeding `RunOptions.input`. One merge algorithm serves both
flag pairs; no new one is introduced.

**To combine `--context` or `--set-context` with `--resume` is a hard CLI validation error**, not a
silent no-op and not a warn-then-ignore. resume-restore-semantics.md §1 already fully determines a
resumed run's starting context by load. A supplied seed would either be discarded or fought over. This
repo already treats silently-discarded operator-facing state as a failure mode to avoid (compare
resume-door-verdict.md §5's treatment of the lying `running` rows). To reject outright surfaces a
mistaken invocation instead of a quiet drop of it.

## Consequences

- Root-level `path run` ends up with two independent, same-shaped seed mechanisms: `--config`/`--set`
  feed `config`, and `--context`/`--set-context` feed `context`. There is no cross-talk between them.
- `--resume`'s own CLI surface (flag spelling settled at
  [#160](https://github.com/howardyang2009/PATH/issues/160)) must add the mutual-exclusion check
  against `--context`/`--set-context` when it lands.
- To declare and validate expected input keys inside the workflow file format stays unimplemented. If
  it is ever wanted, it is additive to this decision, not a change to it.
