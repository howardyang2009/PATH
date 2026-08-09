# Workflow format `@1`: audit carries `node_id`=GUID + `node_name`, block output keyed by name

Status: accepted

[#204](https://github.com/howardyang2009/PATH/issues/204) materializes the identity model of
ADR 0006 into the workflow format: every workflow and node/branch gains a required GUID `id`, and the
current human `id` becomes `name`. This ADR records the concrete, hard-to-reverse consequences of
that materialization — the ones a reader of the format or the audit tables would otherwise find
surprising.

## Decision

- **Format version bumps to `path/workflow@1`.** The required new fields make the shape
  incompatible with `@0`, so the version string changes rather than being redefined in place. The
  loader rejects an `@0` file with a targeted message (the file predates the identity migration —
  run the codemod) rather than a generic zod "invalid literal" on `format`.

- **The audit layer keys on the GUID and narrates the name.** `runs.node_id` and every log event's
  `node_id` carry the **GUID** (the machine identity `plan-reuse` matches on). A **`node_name`** is
  added alongside — to both the log-event envelope and the run row — so the log stream and the
  run-tree API stay human-readable without re-loading the workflow file. `node_id`=GUID and
  `node_name` are both null exactly where the implicit root step sits (the root run row and root
  lifecycle events).

- **Block output is keyed by `name`, not the GUID.** `collect` outputs `{branch-name: output}`;
  `wait-one`'s output field is renamed `id`→`name`: `{ winner: { name, output } }`. The
  `join-applied` event narrates branch names. A step reading `output.winner.id` via interpolation now
  reads `.name`. `name` keeps the whole-file uniqueness rule node ids had, so these keys never
  collide.

- **The migration is a committed repo-internal script, not a shipped command.** Pre-1.0 there are no
  external users with stored workflow files, so a permanent `path migrate` is out of scope. The
  script rewrites this repo's own fixtures and `docs/**/*.workflow.json`, stamping a fresh
  `randomUUID()` on each workflow and node/branch and moving each old `id` value to `name`. No
  id-preservation mapping is needed: #202's schema v4 bump resets `.path/path.db`, so no resume
  continuity spans the migration.

## Consequences

- **Two coupled breaks land together**: the format (`@0`→`@1`, node `id`→`name` + GUIDs) and the
  audit tables (`node_id` now a GUID, new `node_name` column). Both are clean-slate — the store is
  reset, so no old run row carries a stale human `node_id`.
- Renaming a node's `name` no longer breaks resume (the match is on the stable GUID) — the payoff of
  ADR 0006, now concrete.
- The `wait-one` output-contract rename is the sharpest edge: any workflow reading `output.winner.id`
  must switch to `.name`. This repo's fixtures are updated by the same codemod; it is called out here
  because a reader would otherwise assume the old key.
- Branch **arms** are untouched: they are anonymous (`when`+`body`), and `branch-taken` still names
  the winning arm by index/`"else"`.
- A nested workflow-step's run records the *parent* `workflow` node's `id`/`name`, not the referenced
  child file's own workflow identity. Source-workflow identity stays root-only (#202); per-child
  provenance, if ever wanted, is a later issue.
