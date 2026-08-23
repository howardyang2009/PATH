# Refactor plan — resolve a reuse row once

Deepening candidate A from the architecture review. Settled through a grilling pass.

## Friction

A **reuse row** (#257) is a `RunRecord` whose `inputRef`/`outputRef` are `null` and whose real
input/output live under `reusedFromRunId` in another tree (ADR 0001, direct-to-source). Its
provenance is resolved in three places, none of them shared:

- `run-archive.blob()` follows the redirect (`rootRunIdOf(reusedFromRunId)`) to read the source bytes.
- `run-archive.tree()` fills `reusedFromRootRunId` on the record with a *second*, independent
  `rootRunIdOf` call.
- `toWireRunRecord` ships the row's `input_ref`/`output_ref` straight through — still `null`.

The wire `input_ref`/`output_ref` are not fetch handles (they are server-local paths); they are a
**presence signal** for `useRunBlob` and a provenance display line. Because a reuse row is always
terminal (`succeeded`), the viewer reads `settled === true` and fetches anyway, so the null refs
cause no live bug today — the redirect bug `bf4940b` fixed was `blob()` not following the redirect at
all. But the record lies: any future reader that gates on `ref !== null` before `settled` sees an
empty input/output for a row that has both. The redirect logic has no single owner, and
`rootRunIdOf` runs twice per reuse row.

## Constraint

Resolution needs the db (`rootRunIdOf`). `toWireRunRecord` is pure. So the seam **must** live on the
archive read path, not at the wire boundary.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Resolution strategy | **Eager / honest record** — `tree()` resolves each reuse row once; `blob()`, the wire encoder, and the viewer only *read* the resolved record. |
| Q2 | Fix the wire's presence lie | **Yes — fill refs from source**, so a reuse row ships non-null `input_ref`/`output_ref`. |
| Q3 | Scope vs candidates B/C | **Minimal** — populate the existing flat `RunRecord`; leave "name the row kind" (B) and "run-tree module" (C) separate. |
| Q4 | How to produce the refs | **Synthesize from ids** — `blobRef(sourceRoot, reusedFromRunId, …)`. Zero extra reads; source `rm`'d → null root → refs stay null. |
| Q5 | Viewer change | **None** — the record becoming honest is the fix; `node-io.tsx` already reads correctly. |
| Q6 | Where the helper lives | **`run-archive.ts`** — read-path owner; `run-store` stays dumb row↔SQL. |
| Q7 | Commit slicing | **Two commits** (below). |

## The seam

One helper in `run-archive.ts`:

```ts
// A reuse row (#257) owns no blobs: its input/output live under the source run it reused, in that
// run's own tree. Resolve that provenance once here — the source's root run id and the ref strings
// that address its blobs — so tree(), blob(), and the wire all read a record that no longer lies
// about what it has. A source since `rm`'d resolves to null and the refs stay null, matching how
// the blob read already degrades.
function resolveReuseRow(db: Database.Database, run: RunRecord): RunRecord {
  if (run.reusedFromRunId === null) return run;
  const sourceRoot = rootRunIdOf(db, run.reusedFromRunId);
  if (sourceRoot === null) return { ...run, reusedFromRootRunId: null };
  return {
    ...run,
    reusedFromRootRunId: sourceRoot,
    inputRef: blobRef(sourceRoot, run.reusedFromRunId, RUN_BLOB_FILE.input),
    outputRef: blobRef(sourceRoot, run.reusedFromRunId, RUN_BLOB_FILE.output),
  };
}
```

- `tree()` maps every row through `resolveReuseRow`, replacing the current inline `reusedFromRootRunId`
  fill.
- `blob()` reads the already-resolved record: for a reuse row it uses `record.reusedFromRootRunId`
  (non-null) + `record.reusedFromRunId` to build the source dir, and returns `undefined` when
  `reusedFromRootRunId` is null. The second `rootRunIdOf` call is gone.

## What does not change

- No db / schema migration: `reusedFromRootRunId` and the synthesized refs stay computed-on-read.
  `insertReuseRun` and the `runs` table are untouched — the stored row still owns no blobs.
- `toWireRunRecord` is unchanged; it already passes the refs through, and they are now non-null by the
  time it sees a resolved record.
- `cost()` and `blockingSuccessors()` read raw `getRunsForRoot`, not `tree()`, so they are unaffected.
- `getRun` stays (chained-resume source resolution, `project.ts`).
- Viewer untouched.

## Commit plan

1. **`refactor(engine): resolve a reuse row once — synthesize its refs, drop blob()'s second lookup`**
   Add `resolveReuseRow`; `tree()` uses it; `blob()` reads the resolved record. Pins:
   - a reuse row's `tree()` record carries `reusedFromRootRunId` = source root and non-null
     `inputRef`/`outputRef` = `blobRef(source…)`;
   - `blob()` still returns the source's input/output bytes (regression on `bf4940b`);
   - source tree `rm`'d → `reusedFromRootRunId` null, refs null, `blob()` returns `undefined`.

2. **`test(schema): pin the wire ships non-null refs for a resolved reuse row`**
   Assert `toWireRunRecord` on a resolved reuse `RunRecord` emits non-null `input_ref`/`output_ref`
   — the honest-presence contract that removes the latent null-ref trap. Encoder itself unchanged.

## Non-goals

- **B — name the run-row kind** (root / nested / leaf / reuse discriminated instead of null-checked).
- **C — give the run tree a module** (share the flat→nested build across `buildRunTree` / `subtreeCost`).
- Viewer provenance-display polish (showing the source path on the reuse row's ref line).
