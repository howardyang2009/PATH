# One host layout names user folders and host files

**Status:** accepted. Extends [ADR 0087](0087-the-authored-layout-decides-where-a-file-lives-and-who-may-write-it.md)
from authored files to stores and host files.

`join(projectDir, "users", userId)` was computed in eight modules, and the rule that `local`'s store
is the project's own was written twice. `remap-user` hand-listed the host files five other modules
own, so a new host file would have moved into a user's store unnoticed. It also ran raw SQL against
the engine's `runs` table to count and rewrite workflow paths.

## Decision

1. **`host-layout.ts` names `userDir`, `storeDirOf`, `userIds`, `HOST_FILES` and `hostFile`.** A new
   host-level file is added to `HOST_FILES`, and `remap-user` leaves every entry there behind.
2. **The engine owns the run-row rewrite** a user move needs: `countWorkflowPaths` and
   `rewriteWorkflowPaths` over a store's database file.

## Considered options

- **Refusing every offline tool while the Server runs.** Rejected: `remove-shared` and
  `rotate-secrets-key` are designed to run beside a live Server (docs/spec/path-website.md §9);
  only `remap-user` must not.
