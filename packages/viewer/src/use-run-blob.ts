import { PathApiError, type BlobName, type JsonValue, type PathApiClient } from "@path/client-core";
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
 * Who decides absence depends on whether the run is still going, because the two ways of deciding
 * fail in opposite directions:
 *
 * - **Still running, no ref** — skip the read. The route answers 404 for an unknown root, a run
 *   outside that root's tree *and* a missing file alike (`get-run-blob.ts`), so reading a 404 as
 *   "not written yet" would reassure a viewer whose selection is actually stale.
 * - **Terminal** — read regardless of the ref, and trust its 404. A terminal run came from the tree,
 *   so it is not a stale selection, and its ref may simply be absent from a snapshot no tree read
 *   has refreshed since the object was written (#51).
 *
 * A ref that *is* known and fails to load is an error either way: the record and the disk disagree.
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
    if (ref === null && !settled) {
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
        if (cancelled) return;
        // The one 404 that is not a failure: a terminal run the record names no ref for simply
        // recorded no such object.
        if (ref === null && error instanceof PathApiError && error.status === 404) {
          setLoad({ phase: "ready", value: { present: false } });
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
