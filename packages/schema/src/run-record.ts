import type { JsonValue } from "./json-value.js";
import type { RunStatus } from "./run-status.js";
import type { Worker } from "./worker-type.js";

/**
 * One run, as the domain describes it (mvp spec §5.7): the authoritative queryable record of a step
 * run, in the domain's own camelCase spelling.
 *
 * This is deliberately *not* a storage shape. How a run is stored — the `runs` table, its snake_case
 * columns, the JSON-encoded `worker` and `usage` blobs — belongs to `@path/engine`'s run store, which
 * maps its row type onto this one. What a run *is* belongs here, with the format whose execution
 * produces it, so that a reader with no engine (a client, a viewer) can name one.
 *
 * `usage` and `estimatedCostUsd` are populated leaf-only, on the prompt-step run where the tokens
 * were spent; a workflow-run never carries a total of its children's spend, since subtree figures
 * are a read-time SUM.
 */
export interface RunRecord {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  /**
   * The producing node's durable GUID `id` (ADR 0007) — the machine identity `plan-reuse` matches
   * on. Null for the root run: the top-level workflow is wrapped in an implicit root step (invariant 2).
   */
  nodeId: string | null;
  /**
   * The producing node's human `name` (ADR 0007) — carried alongside the GUID so a reader stays
   * human-readable without re-loading the workflow file. Null exactly where `nodeId` is (the root run).
   */
  nodeName: string | null;
  /** Null for a workflow-run's own row; a leaf step run carries the worker it executed on. */
  worker: Worker | null;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** `blobRef` paths into `.path/runs/<root>/<run>/`, not the payloads themselves (§6). */
  inputRef: string | null;
  outputRef: string | null;
  usage: JsonValue | null;
  estimatedCostUsd: number | null;
  /** Null except on a root row created by resuming a prior tree — that predecessor's root run id (#168). */
  resumedFromRootRunId: string | null;
}
