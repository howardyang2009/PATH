import type { RunStatus } from "@path/engine";
import type { JsonValue, Worker } from "@path/schema";

/**
 * The wire shapes of the `@path/server` v0 HTTP contract (server-api-v0.md), as seen from the
 * *client* side. Field casing is snake_case (§1), matching the server's own boundary translation
 * in `@path/server`'s `WireRunRecord` — the two describe the same JSON, one encodes it, this one
 * decodes it. Domain types (`RunStatus`, `Worker`, `JsonValue`) are reused from `@path/engine` /
 * `@path/schema`, not re-invented.
 */

/** One `RunRecord` row on the wire (server-api-v0.md §4), snake_case. */
export interface WireRunRecord {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  worker: Worker | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: JsonValue | null;
  estimated_cost_usd: number | null;
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

/** The shared error envelope for every non-2xx response (server-api-v0.md §1). */
export interface WireError {
  error: {
    message: string;
    details?: JsonValue;
  };
}

/** A blob name addressable via the blob route (server-api-spec.md): a run's input or output. */
export type BlobName = "input" | "output";
