import { connectRunViewModel, type ConnectedRun, type PathApiClient, type RunViewState } from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

/**
 * React binding for one root run. All of the work — the `GET /v0/runs/:root_run_id` hydrate, the
 * SSE subscription, the `Last-Event-ID` resume, the re-read that places a run the stream discovered
 * and the event folding — lives in `connectRunViewModel` on the framework-free side of the seam
 * (map #40). This hook only mirrors the model's snapshots into React state and tears the connection
 * down on unmount or run change.
 *
 * Only the initial connect can fail into `phase: "error"`. A transport drop afterwards is not an
 * error state here: client-core reconnects from the high-water seq on its own, so the tree stays on
 * screen and catches up. That drop is still visible — it rides the snapshot as `RunViewState.stream`
 * and the narrative renders it as "reconnecting" (#48).
 *
 * `rootRunId` is nullable because the app holds exactly one connection for two panes — the run
 * detail and the node I/O — and neither has a run to watch until one is selected. A null id is the
 * `idle` phase, not a load: no request goes out.
 */
export type RunViewLoad = Load<RunViewState> | { phase: "idle" };

export function useRunView(client: PathApiClient, rootRunId: string | null): RunViewLoad {
  const [load, setLoad] = useState<RunViewLoad>({ phase: "idle" });

  useEffect(() => {
    if (rootRunId === null) {
      setLoad({ phase: "idle" });
      return;
    }

    let cancelled = false;
    let connection: ConnectedRun | null = null;
    let unsubscribe: (() => void) | null = null;
    setLoad({ phase: "loading" });

    connectRunViewModel({ client, rootRunId })
      .then((connected) => {
        // The connect is async: by the time it resolves the effect may already have been cleaned up
        // (run switched, pane unmounted). Close the stream the connect just opened rather than
        // leaking it — the cleanup below ran before `connection` was ever assigned.
        if (cancelled) {
          connected.close();
          return;
        }
        connection = connected;
        // Subscribe before reading the snapshot, so an event landing between the two is not lost.
        unsubscribe = connected.model.subscribe((state) => setLoad({ phase: "ready", value: state }));
        setLoad({ phase: "ready", value: connected.model.getState() });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({ phase: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      connection?.close();
    };
  }, [client, rootRunId]);

  return load;
}
