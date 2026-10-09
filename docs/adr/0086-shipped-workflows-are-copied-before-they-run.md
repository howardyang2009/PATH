# Shipped workflows are copied before they run

**Status:** accepted. Supersedes decision 7 of
[ADR 0084](0084-authored-files-live-in-shipped-shared-and-per-user-folders.md) ("shipped workflows are
not part of this change"). Extends [ADR 0085](0085-discovery-lists-only-the-authored-workflow-roots.md).

## Context

PATH will ship many starting-point workflows. The repo kept its samples in `examples/`, but discovery
scans the user's project directory, and a user's project has no `examples/` folder, so those samples
never reached a user.

[ADR 0063](0063-the-workflow-template-is-removed-the-step-template-is-the-only-template.md) removed
the Workflow-Template kind: a starting-point workflow is just a workflow, copied with Save as…. A
shipped workflow must fit that, not bring the kind back.

Running a shipped file in place has three problems. Its launch handle would name a path outside the
project. A run records the file's path, which then points into the PATH install and changes when PATH
moves or updates. And a sample usually needs edits (provider, input, config) before it runs.

## Decision

1. **Shipped workflows live in `packages/server/shipped/workflow/`**, beside the shipped templates.
   They are ordinary `*.workflow.json` files: no new suffix, schema or kind.
2. **Discovery lists them** with `origin: "shipped"`. Their `relative_path` is relative to the
   shipped root. It is a Copy handle, not a launch handle. The workflow tree shows them in a
   `shipped` folder.
3. **A shipped workflow is copied first, never launched or edited in place.** `POST
   /v0/workflows/copy { shipped_path }` copies it into `users/<user-id>/workflow/` and never
   overwrites: an existing target makes the copy take the first free `<name>-<n>` folder or file,
   and the requested workflow's `name` gets the same `-<n>` (amended; it was a `409`). Every copied workflow file gets fresh ids (`instantiateWorkflow`,
   ADR 0006); other files copy verbatim.
4. **The copy unit is the file's top-level folder.** A workflow with refs lives in its own folder
   under the shipped root, and Copy moves that whole folder, so relative refs still resolve (a copy
   never rewires, ADR 0049). A file directly under the shipped root has no refs and is copied alone. A
   test pins both rules and that every shipped workflow loads valid.
5. **The Viewer and the Designer offer Copy to mine** on a shipped row. The Viewer then opens the
   copy's launch form; the Designer's Open picker opens the copy on the canvas. The Designer's other
   pickers (ref target, new-file directory) and its problems pass leave shipped rows out.
6. **`examples/` is removed.** `w1` and `w2` become `release-notes/release-notes.workflow.json` and
   `release-notes/revise.workflow.json`; `jira-workflow.workflow.json` stays a single file.

## Consequences

- A shipped workflow reaches every project that runs this Server.
- A second copy of the same shipped workflow lands beside the first as `<name>-1`, then `-2`.
- The CLI still runs a shipped file by path, for example
  `pnpm path run packages/server/shipped/workflow/release-notes/release-notes.workflow.json`.
