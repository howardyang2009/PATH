import {
  type BlobContent,
  type BlobName,
  type PathApiClient,
  planBlobRead,
  resolveBlobError,
} from "@path/client-core";
import type { Load } from "./load-state.js";
import { useResource } from "./use-resource.js";

export type BlobLoad = Load<BlobContent>;

export interface RunBlobRequest {
  client: PathApiClient;
  rootRunId: string;
  runId: string;
  name: BlobName;
  /** The run record's `input_ref`/`output_ref` for this object; its arrival in a snapshot triggers
   * a re-read. */
  ref: string | null;
  /**
   * A null ref means "not written" only while the run is still going: nothing re-reads the tree
   * after the last run finishes, so a terminal run is asked anyway and its 404 is trusted.
   */
  settled: boolean;
  /** Bumped by the panel's refresh, to re-read an unchanged ref on demand. */
  reloadToken: number;
}

/**
 * Reads one run's `input` or `output` object over `GET /v0/runs/:root_run_id/blobs/:run_id/:name`.
 * The absence rule is the pure {@link planBlobRead}/{@link resolveBlobError} pair in
 * `@path/client-core`; this hook is only the `useState`/`useEffect` wiring around them.
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
  const plan = planBlobRead(ref, settled);
  // A read the plan refuses is a value already known (no blob was written), not a request.
  const { load } = useResource(() => {
    if (!plan.read) return plan.content;
    return client
      .getBlob(rootRunId, runId, name)
      .then((value) => ({ present: true, value }) as BlobContent)
      .catch((error: unknown) => {
        const absent = resolveBlobError(ref, error);
        if (absent !== null) return absent;
        throw error;
      });
  }, [client, rootRunId, runId, name, ref, settled, reloadToken]);
  return load;
}
