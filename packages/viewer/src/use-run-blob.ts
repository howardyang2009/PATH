import type { BlobName, JsonValue, PathApiClient } from "@path/client-core";
import { useEffect, useState } from "react";
import { errorMessage, type Load } from "./load-state.js";

/**
 * A blob read that succeeded: either the run has that object, or the run record carries no ref for
 * it yet. `present` carries the difference a bare `JsonValue | null` cannot — an object whose
 * content *is* JSON `null` is a written object, not a missing one.
 */
export type BlobContent = { present: false } | { present: true; value: JsonValue };

export type BlobLoad = Load<BlobContent>;

export interface RunBlobRequest {
  client: PathApiClient;
  rootRunId: string;
  runId: string;
  name: BlobName;
  /**
   * The run record's `input_ref`/`output_ref` for this object. Null means the engine has not written
   * it — a run has no output until it finishes — so the read is skipped rather than fired at a route
   * that would 404. It doubles as the re-read trigger: the ref appearing in a live snapshot is
   * exactly the moment the object became readable.
   */
  ref: string | null;
  /** Bumped by the panel's refresh, to re-read an unchanged ref on demand. */
  reloadToken: number;
}

/**
 * Reads one run's `input` or `output` object over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`.
 *
 * Absence is decided by the run record's ref, not by a 404: the route answers 404 for an unknown
 * root, a run outside that root's tree *and* a missing file alike (`get-run-blob.ts`), so treating
 * every 404 as "not written yet" would reassure a viewer whose selection is actually stale. With the
 * ref known, a 404 means the record and the disk disagree — a real failure, reported as one.
 */
export function useRunBlob({ client, rootRunId, runId, name, ref, reloadToken }: RunBlobRequest): BlobLoad {
  const [load, setLoad] = useState<BlobLoad>({ phase: "loading" });

  useEffect(() => {
    if (ref === null) {
      setLoad({ phase: "ready", value: { present: false } });
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
        if (!cancelled) setLoad({ phase: "error", message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [client, rootRunId, runId, name, ref, reloadToken]);

  return load;
}
