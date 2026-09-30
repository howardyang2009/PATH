# Discovery lists only the authored workflow roots

**Status:** accepted. Narrows the scan of
[ADR 0011](0011-discovery-lists-all-workflows-roots-flagged.md). Builds on
[ADR 0084](0084-authored-files-live-in-shipped-shared-and-per-user-folders.md).

## Context

`GET /v0/workflows` walked the whole project directory. In this repository that listed test fixtures
under `packages/*/test/fixtures`, samples under `docs/` and `examples/`, and any scratch file at the
root. The Viewer's workflow list and the Designer's pickers showed all of them beside the user's own
workflows.

Skipping `docs/` and `packages/` by name would only fit this repository. In another project those
folders can hold real workflows. ADR 0084 already names where authored workflows live.

## Decision

1. **Discovery scans two roots:** `users/<user-id>/workflow/` (the current user, `local` until the
   Server knows who is asking) and `shared/workflow/`. Each root is walked at any depth, with the same
   skips as before (`node_modules`, dot-directories, symlinks). A missing root lists nothing.
2. **Each row carries `origin`:** `"user"` or `"shared"`. `relative_path` stays project-relative, so it
   is still the launch handle `POST /v0/runs` takes.
3. **Root flagging is unchanged**, computed over the scanned files. A ref may point outside the roots;
   the loader follows it, but the target is not listed.
4. **The workflow tree groups by origin.** Its top level is one folder per origin (`mine`, `shared`),
   and below that the path inside the root. The Viewer's list and the Designer's Open picker start with
   `mine` open.
5. **The Designer's new-file directory picker offers the authored roots** (`users/local/workflow`,
   `shared/workflow`) and the folders under them, not the project root.

## Consequences

- `examples/`, `docs/dogfood/`, `docs/acceptance-workflow/` and test fixtures leave the Viewer and the
  Designer. They still run from the CLI (`pnpm path run examples/w1.workflow.json`). To use one in the
  Viewer, copy it into `shared/workflow/` or `users/local/workflow/`.
- `PUT /v0/workflows` still writes any in-root path. Only the list and the pickers narrow.
- Other users' workflows (`users/<other-id>/workflow/`) are not listed. Listing them needs a real user
  id first.
