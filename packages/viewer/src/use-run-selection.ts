import { useEffect, useRef, useState } from "react";

/**
 * One console's run selection: which root run is watched, which node run is selected inside it, and
 * a nonce that makes the runs list re-read now rather than at its next tick. A launch selects its
 * new root; a delete clears the selection only when it removed the watched one. `scopeKey` names the
 * document the selection belongs to — a Designer switches it when the open workflow changes, so an
 * id from the previous tree never badges the new one.
 */
export interface RunSelection {
  rootRunId: string | null;
  selectedRunId: string | null;
  /** Bumped by a launch, a resume or a delete, to re-read the runs list in place. */
  reloadNonce: number;
  /** Watch a root run and drop the node selection: an id from the previous tree names nothing. */
  selectRootRun(rootRunId: string): void;
  selectRun(runId: string | null): void;
  /** A launch or a resume: watch the new root and nudge the list. */
  watchNewRun(rootRunId: string): void;
  /** A delete: drop the watched run when it was the one removed, then nudge the list. */
  onDeleted(rootRunId: string): void;
}

export function useRunSelection(scopeKey?: string | null): RunSelection {
  const [rootRunId, setRootRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // A scope change re-bases the console on a document that names none of the selected ids.
  const previousScope = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = scopeKey;
    if (previous === undefined || previous === scopeKey) return;
    setRootRunId(null);
    setSelectedRunId(null);
  }, [scopeKey]);

  const selectRootRun = (runId: string): void => {
    setRootRunId(runId);
    setSelectedRunId(null);
  };

  return {
    rootRunId,
    selectedRunId,
    reloadNonce,
    selectRootRun,
    selectRun: setSelectedRunId,
    watchNewRun(runId) {
      selectRootRun(runId);
      setReloadNonce((nonce) => nonce + 1);
    },
    onDeleted(runId) {
      if (runId === rootRunId) {
        setRootRunId(null);
        setSelectedRunId(null);
      }
      setReloadNonce((nonce) => nonce + 1);
    },
  };
}
