import type { JsonValue } from "./json-value.js";
import type { RunRecord } from "./run-record.js";
import type { RunStatus } from "./run-status.js";
import type { Worker } from "./worker-type.js";

/**
 * The wire shapes of the `@path/server` v0 HTTP contract (docs/api/server-api-v0.md).
 *
 * One declaration, shared by both ends. Before this the record was declared once in `@path/server`
 * to encode and once in `@path/client-core` to decode, in packages with no dependency between them,
 * so the two were structurally unrelated types held in agreement by a prose comment — a field
 * renamed on one side type-checked cleanly on both and broke only at runtime, in the browser.
 *
 * Field casing is snake_case (§1), which is the whole reason a translation exists: the domain speaks
 * camelCase (`RunRecord`) and the wire speaks snake_case. `toWireRunRecord` is that translation,
 * beside the two shapes it maps between. There is no inverse: the server encodes, and the client
 * projects the wire record straight onto its own view state (`client-core/view-model.ts`) rather
 * than decoding back to a domain record it has no other use for.
 */

/** One `RunRecord` on the wire (server-api-v0.md §4), snake_case. */
export interface WireRunRecord {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  node_name: string | null;
  worker: Worker | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: JsonValue | null;
  estimated_cost_usd: number | null;
  resumed_from_root_run_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_path: string | null;
}

/** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
export interface RunTreeResponse {
  root_run_id: string;
  status: RunStatus;
  output: JsonValue | null;
  runs: WireRunRecord[];
}

/** One entry of `GET /v0/runs` — the root-run summary shape only (server-api-v0.md §3). */
export interface RootRunSummary {
  run_id: string;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
}

/** `GET /v0/runs` — list of root runs, most recent first (server-api-v0.md §3). */
export interface ListRunsResponse {
  runs: RootRunSummary[];
}

/** `POST /v0/runs` — the 202 body (server-api-v0.md §4.1). */
export interface StartRunResponse {
  run_id: string;
  root_run_id: string;
}

/** The shared error envelope for every non-2xx response (server-api-v0.md §1). */
export interface WireError {
  error: {
    message: string;
    details?: JsonValue;
  };
}

/** A blob name addressable via the blob route (server-api-v0.md §4.3): a run's input or output. */
export type BlobName = "input" | "output";

/** Domain record → wire. The one encode; every route that emits a run row goes through it. */
export function toWireRunRecord(row: RunRecord): WireRunRecord {
  return {
    run_id: row.runId,
    root_run_id: row.rootRunId,
    parent_run_id: row.parentRunId,
    node_id: row.nodeId,
    node_name: row.nodeName,
    worker: row.worker,
    status: row.status,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    input_ref: row.inputRef,
    output_ref: row.outputRef,
    usage: row.usage,
    estimated_cost_usd: row.estimatedCostUsd,
    resumed_from_root_run_id: row.resumedFromRootRunId,
    workflow_id: row.workflowId,
    workflow_name: row.workflowName,
    workflow_path: row.workflowPath,
  };
}

/** The root-run summary `GET /v0/runs` returns — a projection of the full record, not a new shape. */
export function toRootRunSummary(row: RunRecord): RootRunSummary {
  return {
    run_id: row.runId,
    status: row.status,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
  };
}
