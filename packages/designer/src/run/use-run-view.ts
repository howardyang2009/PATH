import { connectRunViewModel, type ConnectedRun, type PathApiClient, type RunViewState } from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

/**
 * React binding for one root run. All of the work — the `GET /v0/runs/:root_run_id` hydrate, the SSE
 * subscription, the `Last-Event-ID` resume, and the event folding — lives in `connectRunViewModel` on
 * the framework-free side of the seam (reused unchanged, ADR 0025). This hook only mirrors the model's
 * snapshots into React state and tears the connection down on unmount or run change. The Designer's own
 * copy — the hook wiring stays per-surface (ADR 0025).
 *
 * Only the initial connect can fail into `phase: "error"`. A transport drop afterwards is not an error
 * here: client-core reconnects from the high-water seq on its own, so the snapshot stays on screen and
 * catches up. That drop rides the snapshot as `RunViewState.stream` for a liveness indicator.
 *
 * `rootRunId` is nullable: the Designer holds one connection whose two consumers — the canvas projection
 * and the inspector — have nothing to watch until a run is selected. A null id is the `idle` phase, not
 * a load: no request goes out.
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
        // (run switched, unmounted). Close the stream the connect just opened rather than leaking it.
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
