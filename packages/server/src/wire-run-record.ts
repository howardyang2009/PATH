import type { RunRecord } from "@path/engine";

/**
 * The wire shape of a `RunRecord` (server-api-v0.md §4): the engine's internal fields are
 * camelCase, but every field is snake_case on the wire (§1) — translated at this one seam.
 */
export interface WireRunRecord {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  worker: RunRecord["worker"];
  status: RunRecord["status"];
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: RunRecord["usage"];
  estimated_cost_usd: number | null;
}

export function toWireRunRecord(row: RunRecord): WireRunRecord {
  return {
    run_id: row.runId,
    root_run_id: row.rootRunId,
    parent_run_id: row.parentRunId,
    node_id: row.nodeId,
    worker: row.worker,
    status: row.status,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    input_ref: row.inputRef,
    output_ref: row.outputRef,
    usage: row.usage,
    estimated_cost_usd: row.estimatedCostUsd,
  };
}
