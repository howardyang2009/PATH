import { useState } from "react";
import type { PathApiClient } from "@path/client-core";
import { useRunView } from "@path/viewer";

/**
 * The Designer's **run-watching** state (#372), gathered out of `App` into one module. The App used to hold
 * three `useState` (the watched root run, the run inside its tree, a reload nonce), the `useRunView`
 * connection, and the select/launch/resume/delete transitions, interleaved with the unrelated authoring
 * state. Here they are one small interface, and the one invariant they share — **a new root run drops the
 * run-inside-the-tree selection**, because a run id from the previous tree names nothing in the new one —
 * lives once, in `selectRootRun`, instead of being re-spelled across three handlers.
 *
 * One connection, owned here, feeds both the canvas projection and the inspector: the two are views of one
 * live snapshot, and a second connection would tell the same story a beat apart. The App reads the derived
 * values (`runsForProjection`, `workflowRunStatus`) and wires the transitions straight onto the run dock.
 */
export function useRunWatch(client: PathApiClient) {
  // The watched root run, and the run inside its tree the inspector shows. `null` when nothing is watched.
  const [rootRunId, setRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Bumped to make the run list re-read now (a launch/resume/delete just changed it), not at the next tick.
  const [reloadNonce, setReloadNonce] = useState(0);

  const load = useRunView(client, rootRunId);
  // The runs feeding the canvas projection, and the watched run's workflow-level (root run) status. The root
  // run has no `nodeId`, so it projects onto no canvas node — the App badges the breadcrumb with it instead.
  const runsForProjection = load.phase === "ready" ? load.value.runs : null;
  const workflowRunStatus = load.phase === "ready" ? load.value.status : null;

  // Switching root run drops the node-in-tree selection: a run id from the previous tree names nothing here.
  const selectRootRun = (id: string): void => {
    setRootRunId(id);
    setSelectedRunId(null);
  };

  // A launch/resume is the same transition as a click — watch the new run — plus a nudge so the list
  // re-reads and shows the new row now, not at the next periodic tick.
  const watchNewRun = (id: string): void => {
    selectRootRun(id);
    setReloadNonce((nonce) => nonce + 1);
  };

  // A delete drops the watched run if it was the one removed (its tree is gone), then re-reads the list so
  // the row disappears now rather than at the next periodic tick — the mirror of a launch.
  const onDeleted = (id: string): void => {
    if (id === rootRunId) {
      setRootRunId(null);
      setSelectedRunId(null);
    }
    setReloadNonce((nonce) => nonce + 1);
  };

  return {
    /** The live run-view load — the run dock's `load` prop; also the source of the two derived values below. */
    load,
    /** The watched tree's runs for the canvas projection, or `null` when nothing is watched. */
    runsForProjection,
    /** The watched root run's workflow-level status for the breadcrumb badge, or `null`. */
    workflowRunStatus,
    /** The watched root run id, or `null`. */
    rootRunId,
    /** The selected run inside the watched tree, or `null`. */
    selectedRunId,
    /** The run-list reload nonce — bumped on launch/resume/delete. */
    reloadNonce,
    /** Watch `id` as the root run, dropping the in-tree selection. */
    selectRootRun,
    /** Select a run inside the watched tree (the inspector target). */
    selectRun: setSelectedRunId,
    /** Watch a just-launched/resumed run and nudge the list to re-read. */
    watchNewRun,
    /** Handle a deleted root run: drop it if watched, then nudge the list to re-read. */
    onDeleted,
  };
}
