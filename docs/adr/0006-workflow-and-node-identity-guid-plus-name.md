# Workflow and node identity: a durable GUID `id` plus a human `name`

Status: accepted

[#202](https://github.com/howardyang2009/PATH/issues/202) asked to persist a *source-workflow
identity* on each root run so a central store (`path run -C <dir>`, ADR 0005) can tell one
workflow's runs from another's instead of listing anonymous run-ids. Grilling that question
established that neither of the identifiers the format had was sufficient on its own: the human
`name` field is not unique across files (two files may both be named `foo`), and a file path is
brittle across machines. The fix is a durable identity that lives in the workflow itself.

## Decision

Every **workflow** and every **node/branch** carries two identifiers:

- **`id`** — a GUID (UUIDv4), the stable *machine* identity. Unique by construction, assigned once,
  never regenerated. It is the reuse/resume key (`plan-reuse` matches a successor node to a
  predecessor run by shared `id`) and the durable `node_id` a run row and log event carry.
- **`name`** — the human label (`^[a-z][a-z0-9-]*$`), the *readable* identity. It keys
  `collect`/`wait-one` output objects, is what the log stream narrates, and is the display/filter
  key in `path runs list`.

The current human `id` on a node **becomes `name`**; the `id` field is repurposed for the GUID. The
workflow already had `name`; it gains `id`.

Each **root run** records the producing workflow's **source-workflow identity** — the trio
`{id, name, relative-path}` (path relative to the store dir) — root-only, in new `runs` columns.
`path runs list` shows a `workflow` column (the name) and supports `--workflow <name>` (exact) and
`--workflow-id <guid>`.

`id` is genuinely **required**: a missing `id` is a load error, not a silent per-run auto-stamp. The
one sanctioned write-back is a one-time codemod that stamps every pre-existing `workflow.json`.

## Considered Options

- **`name` only** (the issue's first option). Rejected: not unique across files, so a shared store
  still can't reliably distinguish two `foo` workflows.
- **Path only.** Rejected: brittle across machines and moves; provenance, not identity.
- **Content-hash id** (no field, derive from bytes). Rejected: editing a workflow would change its
  identity, breaking the grouping and every resume match — the opposite of durable.
- **Auto-stamp with per-run write-back** (fill a missing `id` and rewrite the source on every run).
  Rejected as the steady state: it mutates the operator's source file on an ordinary `run`
  (git-diff noise, fails on read-only FS, races under concurrent runs). Kept only as the one-time
  codemod.
- **GUID at every surface** (output keys and log narration carry the UUID). Rejected: opaque
  operator-facing data. Human `name` surfaces; the GUID rides as the durable audit id.

## Consequences

- **Format break.** The node `id`→`name` rename plus required GUIDs on the workflow and every node
  is not backward-compatible. Every existing `workflow.json` is rewritten by a one-time codemod.
  This work is split into its own prerequisite ticket (the format change + file rewrite); #202
  narrows to consuming the now-guaranteed workflow GUID and the persist/display half.
- **Resume is now GUID-keyed**, an improvement: renaming a node's `name` no longer breaks reuse,
  because the match is on the stable `id`. The flip side — a node's `id` must never be regenerated,
  or resume silently stops reusing it.
- **DB schema v3→v4**, bump-and-break (no migration framework pre-1.0; blobs under `.path/runs/`
  survive). Because the store is a clean slate, no root row ever has a null identity — backfill is
  moot.
- Copying a `workflow.json` copies its `id`, so a fork shares identity until the operator changes or
  clears the `id`. The GUID kills *accidental name collisions*; it cannot police deliberate copies.
