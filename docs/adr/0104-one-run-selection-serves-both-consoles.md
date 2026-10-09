# One run selection serves both consoles

**Status:** accepted.

The Viewer's `RunsConsole` and the Designer's `useRunWatch` each held the same three pieces of state
— the watched root run, the selected node run, and a nonce that re-reads the runs list — and each
defined the same transitions: selecting a root drops the node selection, a launch or resume selects
the new root and nudges the list, a delete clears the watch only when it removed the watched run.
The two copies had the same shape and the same stated rationale, and the Designer's carried one
extra rule (a new open workflow re-bases the selection).

## Decision

1. **`useRunSelection` owns the selection.** It returns `rootRunId`, `selectedRunId`, `reloadNonce`,
   `selectRootRun`, `selectRun`, `watchNewRun` and `onDeleted`, and takes an optional `scopeKey`
   whose change re-bases the selection. It lives in `@path/viewer` and is exported from the barrel
   and the `@path/viewer/use-run-selection` subpath.
2. **Both consoles mount it.** `RunsConsole` uses it directly; the Designer's `useRunWatch` is the
   hook plus its one `useRunView` connection and the two display readings the canvas needs.

## Consequences

- The selection transitions, including the "a delete clears the watch only when it removed the
  watched run" rule, have one home and one test surface (`use-run-selection.test.ts`).
- The Designer keeps its scope-change reset as the hook's `scopeKey`, not as a second effect.
- `useRunView` stays the connection; the selection does not own the SSE stream.
