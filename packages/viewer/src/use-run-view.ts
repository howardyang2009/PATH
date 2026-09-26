import {
  type ConnectedRun,
  connectRunViewModel,
  type PathApiClient,
  type RunViewState,
} from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

/**
 * React binding for one root run. The hydrate, SSE subscription, `Last-Event-ID` resume, discovered-run
 * re-read and event folding live in `connectRunViewModel`; this hook mirrors the model's snapshots into
 * React state. Only the initial connect fails into `phase: "error"` — a transport drop reconnects itself
 * and rides the snapshot as `RunViewState.stream`. A null `rootRunId` is `idle`, not a load.
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
        // The connect is async: by the time it resolves the effect may already be cleaned up, so close
        // the stream it just opened.
        if (cancelled) {
          connected.close();
          return;
        }
        connection = connected;
        // Subscribe before reading the snapshot, so an event landing between the two is not lost.
        unsubscribe = connected.model.subscribe((state) =>
          setLoad({ phase: "ready", value: state }),
        );
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
