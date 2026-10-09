# One run history carries the predecessor tree

**Status:** accepted.

Resume and Complete each carried "the tree this continuation reads" as two loose values: a row array
and a blob reader. The pair travelled separately through `ResumeInput` and `ContinueInput`, through
`runWorkflow` into every walker, and through `ContinueState`; each door rebuilt it
(`project-resume.ts`, `project-complete.ts`), and the direct-to-source rule of
[ADR 0001](0001-a-reuse-row-names-the-source-run-directly.md) was implemented twice — once in
`continuationBlobReader`, once in `RunArchive.resolveReuseRow`. No module owned what a recorded tree
*is* for a continuation.

## Decision

1. **`run-history.ts` owns the handle.** `RunHistory` is `{ rows, blob(run, filename) }`:
   `diskRunHistory(db, projectDir, rows)` is the store adapter, performing the reuse-row swap when it
   is built; `runHistory(rows, blob)` builds one over in-memory rows for a test.
2. **The continuation inputs carry it.** `ResumeInput.history` and `ContinueInput.history` replace
   `originalRuns`/`existingRuns` + `readBlob`, and `ContinueState.history` replaces the same pair. A
   scope's `ResumeEntry` carries the history it resumes against, so `rootResumeEntry` no longer
   reaches into the input for the predecessor's root.
3. **The two helpers move with it.** `sourceRuns` and `continuationBlobReader` are no longer
   exported from `continuation.ts`; their logic is `diskRunHistory`'s body.

## Consequences

- `@path/engine`'s exported `ResumeInput` and `ContinueInput` change shape; the Server only reaches
  them through `Project.resume`/`Project.complete`, so no door changed.
- A test builds a predecessor tree as `runHistory(rows, blob)` instead of an array plus a callback,
  and `run-history.test.ts` pins the swap and the blob addressing directly.
- The second adapter already exists in fact — the hosted path copies a tree in and out of a VM — so
  the seam is earned, not hypothetical.
