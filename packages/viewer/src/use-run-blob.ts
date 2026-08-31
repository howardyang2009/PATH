import { planBlobRead, resolveBlobError, type BlobContent, type BlobName, type PathApiClient } from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

export type BlobLoad = Load<BlobContent>;

export interface RunBlobRequest {
  client: PathApiClient;
  rootRunId: string;
  runId: string;
  name: BlobName;
  /**
   * The run record's `input_ref`/`output_ref` for this object, as the live snapshot carries it. It
   * doubles as a re-read trigger: the ref appearing in a snapshot is one moment the object is known
   * to have become readable.
   */
  ref: string | null;
  /**
   * Whether the run has reached a terminal status. A null ref means "not written" only while the run
   * is still going: refs enter the snapshot through a tree read, and nothing re-reads the tree after
   * the last run in it finishes, so a terminal run may hold an object its snapshot does not name
   * (#51). Terminal runs are therefore asked anyway, and their 404 is trusted.
   */
  settled: boolean;
  /** Bumped by the panel's refresh, to re-read an unchanged ref on demand. */
  reloadToken: number;
}

/**
 * Reads one run's `input` or `output` object over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`.
 *
 * The absence rule — whether to read at all, and whether a caught 404 is a benign "no such object"
 * or a real failure — is the pure {@link planBlobRead}/{@link resolveBlobError} pair in
 * `@path/client-core` (#359), shared with the Designer. This hook is only the `useState`/`useEffect`
 * wiring around them.
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
