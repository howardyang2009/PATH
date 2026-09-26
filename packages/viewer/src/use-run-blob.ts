import {
  type BlobContent,
  type BlobName,
  type PathApiClient,
  planBlobRead,
  resolveBlobError,
} from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

export type BlobLoad = Load<BlobContent>;

export interface RunBlobRequest {
  client: PathApiClient;
  rootRunId: string;
  runId: string;
  name: BlobName;
  /** The run record's `input_ref`/`output_ref` for this object; its arrival in a snapshot triggers a re-read. */
  ref: string | null;
  /**
   * A null ref means "not written" only while the run is still going: nothing re-reads the tree after
   * the last run finishes, so a terminal run is asked anyway and its 404 is trusted.
   */
  settled: boolean;
  /** Bumped by the panel's refresh, to re-read an unchanged ref on demand. */
  reloadToken: number;
}

/**
 * Reads one run's `input` or `output` object over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`. The
 * absence rule is the pure {@link planBlobRead}/{@link resolveBlobError} pair in `@path/client-core`;
 * this hook is only the `useState`/`useEffect` wiring around them.
 */
export function useRunBlob({
  client,
  rootRunId,
  runId,
  name,
  ref,
  settled,
  reloadToken,
}: RunBlobRequest): BlobLoad {
  const [load, setLoad] = useState<BlobLoad>({ phase: "loading" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the caller's re-read signal.
  useEffect(() => {
    const plan = planBlobRead(ref, settled);
    if (!plan.read) {
      setLoad({ phase: "ready", value: plan.content });
      return;
    }

    let cancelled = false;
    setLoad({ phase: "loading" });

    client
      .getBlob(rootRunId, runId, name)
      .then((value) => {
        if (!cancelled) setLoad({ phase: "ready", value: { present: true, value } });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const absent = resolveBlobError(ref, error);
        if (absent !== null) {
          setLoad({ phase: "ready", value: absent });
          return;
        }
        setLoad({ phase: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [client, rootRunId, runId, name, ref, settled, reloadToken]);

  return load;
}
