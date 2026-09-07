# The Resume-from-K eligibility listing rides `path run --resume --list-eligible`, not a `path runs show`

Status: accepted

Issue [#441](https://github.com/howardyang2009/PATH/issues/441) (part of map
[#427](https://github.com/howardyang2009/PATH/issues/427), dependency of
[#431](https://github.com/howardyang2009/PATH/issues/431)) asks for a per-tree listing so an operator
can find a legal `--from <run-id>` value before they resume. The listing's whole point is the
**`eligible?`** column: it names, per node, whether that node is a legal rerun boundary **K** and, when
it is not, the reason from the ADR-0032 taxonomy. We put that listing on the resume form itself —
`path run <workflow.json> --resume <root-run-id> --list-eligible` — rather than on the file-free
`path runs` family the issue proposed (`path runs show <root-run-id>`), because a truthful `eligible?`
column needs the workflow file, and files live on `path run`, never on `path runs`. The full spec is
[docs/spec/resume-eligibility-listing.md](../spec/resume-eligibility-listing.md).

## Considered Options

### Where the listing lives

- **A list mode of the resume form** — `path run <workflow.json> --resume <root-run-id> --list-eligible`
  (chosen). `--list-eligible` requires `--resume`, is mutually exclusive with `--from`, and launches
  nothing. The workflow file and the root run id sit exactly where `--from` will sit, so the listing is
  computed against the very file the operator will resume with, and it reuses the engine's one legal-K
  resolver by construction.
- **A `path runs show <root-run-id>` subcommand** (the issue's proposal). Rejected. The `runs` family is
  file-free by design — it operates on the `.path/` store the way a `git` subcommand operates on a repo
  (`path runs`, `runs rm`, `runs prune`, `runs -C`; mvp-spec §3, ADR 0005). A truthful `eligible?`
  column cannot be computed store-only: **logicers leave no run row** (invariant 1), so the run tree
  keyed on `parentRunId` cannot separate a top-level node from one nested inside a loop / parallel /
  branch body — both carry the enclosing workflow-run as parent. Three of the four listing-relevant
  legal-K reasons (locus, prefix-`<K`-succeeded, and file-presence for a since-deleted node) therefore
  need the workflow structure, not the rows. A store-only `path runs show` could prove only
  `succeeded`; its `eligible?` cell would say *eligible* on nodes that `--from` then refuses — the one
  thing the column exists to prevent.
- **`path runs show <root-run-id>`, auto-loading the file from the root run's recorded source-workflow
  identity.** Rejected. The recorded **relative-path** is brittle across machines (`CONTEXT.md`
  §Identity), and the auto-loaded file may not be the file the operator resumes with, so the column
  would lie again wherever the current file diverged.

## Consequences

- **One authority, no divergence.** The `eligible?` verdict per row and the single-selection legal-K
  check that `Project.resume` runs before a successor starts (ADR 0032) call the **same** predicate over
  the same inputs (the source tree rows plus the current file). The listing can never say *eligible*
  where `--from` refuses, or vice-versa. This is the realization of ADR 0032's "one authority resolves
  and validates."
- **The `runs` family stays file-free.** No `workflow.json` positional or `--against` flag leaks onto
  `path runs`, so the family keeps its store-only, git-subcommand shape.
- **A reader who saw the issue is surprised.** The issue names `path runs show`; the code has no such
  command. This ADR is why: eligibility needs the file, and the file lives on `path run`.
- **Read-only, launches nothing.** `--list-eligible` is a dry-run of resume. It reuses `path run`'s
  existing `-C` store resolution and file-load errors unchanged, and it refuses a non-terminal source
  run with the same message and exit code a real resume would give.
