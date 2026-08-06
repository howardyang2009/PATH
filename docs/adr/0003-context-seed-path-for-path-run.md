# `path run` gains `--context`/`--set-context`; combining either with `--resume` is a hard error

Status: accepted

[resume-door-verdict.md §3](../research/resume-door-verdict.md) found that root-level `path run
<file>` has no documented way to seed a file's starting `context` — only its `config`, via
`--config <file>`/`--set key=value`. This ticket ([#162](https://github.com/howardyang2009/PATH/issues/162),
chartered by map [#158](https://github.com/howardyang2009/PATH/issues/158)) closes that gap.
It is **not** a `--resume` mechanism: [resume-restore-semantics.md §1](../research/resume-restore-semantics.md)
already settles that a resumed run's context is restored **by load** from the original tree,
automatic, no operator input. This flag serves fresh (non-`--resume`) runs — chiefly, testing one
workflow step in isolation by seeding whatever prior context it expects to read via `${context.x}`.

## Considered Options

- **Overload `--set` with a `context.`-prefixed key** instead of new flags. Rejected: routes two
  different destinations (`config` vs `context`) through one flag by string-prefix convention,
  inconsistent with how `buildOperatorConfig`/`mergeConfig` already keep concerns separate
  elsewhere in the CLI.
- **`--input`/`--set-input` naming**, matching the format doc's own term for the seed object
  (workflow-format-v0.md §6.3: "workflow's input object seeds context"; the nested `workflow`
  step's own field is literally `input`; `RunOptions.input` already exists engine-side in
  `run-workflow.ts`). Considered, not chosen — `--context`/`--set-context` was picked instead,
  naming the destination the operator is trying to affect rather than the spec's internal term for
  the seed object.
- **File-only flag, no per-key override.** Rejected: the testing use case is "tweak one context
  key, rerun" — a fast `--set-context key=value` path beats editing a JSON file each iteration.
- **Declare/validate expected input keys in the workflow file itself**
  (workflow-format-v0.md §2's other named "possible additive extension"). Out of scope for this
  ticket — a `checkpoint` node already covers the testing use case's validation need (assert
  `${context.x}` is set, fail the run otherwise), so no schema change is required to unblock it.

## Decision

`path run <file>` gains:

- `--context <file>` — whole JSON object, same validation `--config` already has (must be a JSON
  object, error otherwise — forced by workflow-format-v0.md §6.3, which reads "top-level keys" of
  the seed).
- `--set-context key=value`, repeatable — same `JSON.parse`-or-raw-string-fallback as `--set`.

Both merge via the existing `mergeConfig` nearest-wins rule (file loads first, `--set-context`
pairs override individual top-level keys), feeding `RunOptions.input`. One merge algorithm serves
both flag pairs; no new one is introduced.

**Combining `--context` or `--set-context` with `--resume` is a hard CLI validation error**, not a
silent no-op and not a warn-then-ignore. resume-restore-semantics.md §1 already fully determines a
resumed run's starting context by load — a supplied seed would either be discarded or fought over.
This repo already treats silently-discarded operator-facing state as a failure mode to avoid (cf.
resume-door-verdict.md §5's treatment of the lying `running` rows); rejecting outright surfaces a
mistaken invocation instead of quietly dropping it.

## Consequences

- Root-level `path run` ends up with two independent, same-shaped seed mechanisms:
  `--config`/`--set` → `config`, `--context`/`--set-context` → `context`. No cross-talk between
  them.
- `--resume`'s own CLI surface (flag spelling settled at [#160](https://github.com/howardyang2009/PATH/issues/160))
  must add the mutual-exclusion check against `--context`/`--set-context` when it lands.
- Declaring/validating expected input keys inside the workflow file format stays unimplemented;
  if it's ever wanted, it is additive to this decision, not a change to it.
