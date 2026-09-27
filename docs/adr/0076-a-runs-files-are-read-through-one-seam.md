# A run's files are read through one seam

**Status:** accepted.

The awaiting surfaces (ADR 0031, ADR 0040) answer one question of a run: which node does it show?
The node's `description`, `assignee` and `outputSchema` live in the workflow file that defines it,
which may be a nested `ref` file, so the surface needs *a set of files* — and the two surfaces held
different ones:

- the **Viewer** read the root file and every file its `workflow` refs reach, transitively, from disk
  (`loadReachableWorkflowFiles`);
- the **Designer's run dock** handed the Viewer's panels its **open buffer** — `[rootFile]` — because
  that was the file it had.

Two adapters over one interface disagreed in production. A `person-activity` leaf inside a nested
`ref` file resolved in the Viewer and read as unresolved in the Designer, and a *dirty* buffer built
a Complete form from bytes the server would never validate — the server reads the current file at
Complete (ADR 0040), so the buffer was the wrong authority even when it held the node.

## Decision

1. **`@path/client-core` owns `RunFileSet`**: the files a run's node ids resolve against, as the
   question the surfaces ask — `rootFile` (the file the `Resume from …` legal-K check reads) and
   `awaitingNode(run)`.
2. **Two adapters, one per source of files.** `runFileSetFromDisk(client, rootPath)` reads the root
   file and every transitively-ref'd child, degrading a missing one out of the set;
   `runFileSetOf(files)` wraps a set the caller already holds (a test, a fixture).
3. **Both surfaces read from the store.** The Viewer loads the set for the watched run's recorded
   workflow path; the Designer's run dock loads it for the open file's path. The open buffer is not
   an adapter: what the author has typed is not what Complete will validate.
4. **`awaitingNodeForRun` stays the implementation** of the question, and the array form is its
   adapter, so the one rule — `awaiting`, a node id, and a `person-activity` node — is unchanged.

## Considered Options

- **One seam with a disk adapter and a buffer adapter** (the shape the review proposed). Rejected on
  the evidence above: the buffer adapter is exactly the defect. The open buffer remains a legitimate
  *view* of the file for the canvas, not for a run's node lookup.
- **Fetch inside the panes** (`RunDetail`, `NodeIo`). Rejected: two panes would read twice, and the
  third consumer (the run tree's assignee chip) would need a third read.
- **Keep passing `WorkflowFile[]` and let each surface decide.** Rejected: the decision is the bug;
  it belongs in one module.

## Consequences

- **The Designer's dock reads the file set from the store** when its open path changes, so a nested
  leaf resolves and a dirty buffer cannot change the Complete form. `run-surfaces.test.tsx` pins the
  nested case.
- **The Viewer's bootstrap read runs through the same seam** and through `useResource`, so its
  cancellation and failure rules are the shared ones.
- **A set that could not be read is the shared empty set**: the awaiting surfaces degrade to the
  schema-less submit, as before.
