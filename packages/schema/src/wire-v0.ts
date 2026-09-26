import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { LaunchFacts } from "./launch-facts.js";
import type { LogBackendId } from "./log-backend-id.js";
import { type RerunFromNodePathEntry, RUN_RECORD_FIELDS, type RunRecord } from "./run-record.js";
import type { RunStatus } from "./run-status.js";

/**
 * The wire shapes of the `@path/server` v0 HTTP contract (docs/api/server-api-v0.md), shared by both ends
 * so a field renamed on one side cannot type-check on both and break only at runtime (ADR 0013).
 */

/** One `RunRecord` on the wire (server-api-v0.md §4), snake_case. */
export interface WireRunRecord {
  run_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  node_id: string | null;
  node_name: string | null;
  /** Null for a workflow-run's own row; a leaf step run carries its worker's *name* (ADR 0021 sub-14). */
  worker_name: string | null;
  /** The 1-based ordinal of a `while-do` iteration container (ADR 0037), null on every other kind. */
  iteration: number | null;
  /** The 1-based ordinal of a goto pass container (ADR 0054), null on every other kind. */
  pass: number | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: JsonValue | null;
  estimated_cost_usd: number | null;
  resumed_from_root_run_id: string | null;
  /** The rerun boundary (K) descent path this successor root run resumed from (ADR 0032); null on plain Resume. */
  rerun_from_node_path: RerunFromNodePathEntry[] | null;
  /** Set only on a reuse row: the source run whose output it reuses, direct-to-source. */
  reused_from_run_id: string | null;
  /** Set only on a reuse row: the root run id of the tree the source run lives in. */
  reused_from_root_run_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_path: string | null;
}

/** The operator's frozen launch facts on the wire (ADR 0046), carried once per tree on `RunTreeResponse`. */
export interface WireLaunchFacts {
  input?: JsonValue;
  config?: ConfigObject;
  worker_defaults?: { [stepType: string]: string };
  secret_keys?: string[];
}

export interface RunTreeResponse {
  root_run_id: string;
  status: RunStatus;
  output: JsonValue | null;
  runs: WireRunRecord[];
  /**
   * What the run was launched with (ADR 0046); `config` is masked, so a `$secret` reads as its `[secret:<key>]`
   * token.
   */
  launch_facts?: WireLaunchFacts;
}

/** One entry of `GET /v0/runs` — the root-run summary shape only (server-api-v0.md §3). */
export interface RootRunSummary {
  run_id: string;
  workflow_name: string | null;
  workflow_id: string | null;
  workflow_path: string | null;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  /** The launch config keys recorded as secrets (ADR 0046) — names only; present only when the launch had them. */
  launch_secret_keys?: string[];
}

export interface ListRunsResponse {
  runs: RootRunSummary[];
}

/**
 * `POST /v0/runs` request body (server-api-v0.md §2), snake_case; shared so client-encode and server-decode cannot
 * drift.
 */
export interface StartRunRequest {
  workflow_path: string;
  input?: JsonValue;
  config?: ConfigObject;
  /**
   * The operator's run-wide launch worker-default table (ADR 0044): a peer of `input`/`config`, not
   * inside `config`, which dispatch never reads for worker selection. Frozen with the run.
   */
  worker_defaults?: { [stepType: string]: string };
  log_backends?: LogBackendId[];
  processor_concurrency?: number;
}

export interface StartRunResponse {
  run_id: string;
  root_run_id: string;
}

/**
 * `POST /v0/runs/:step_run_id/complete` body (server-api-v0.md §4.4): the person's `output` and an optional `config`
 * override.
 */
export interface CompleteRunRequest {
  output: JsonValue;
  config?: ConfigObject;
}

export interface CompleteRunResponse {
  step_run_id: string;
  root_run_id: string;
}

/**
 * The edit lease's JSON (`POST /v0/workflows/lock` and heartbeat replies, and the `.editing` marker on
 * disk), server-authored snake_case (server-api-v0.md §7.2, ADR 0017). `expires_at` is server-computed,
 * never read from the client — a client-set expiry could pin a lease forever.
 */
export interface WireWorkflowLease {
  session_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

/** `POST /v0/workflows/lock` request body — acquire or take over (ADR 0017). */
export interface WireLockRequest {
  workflow_path: string;
  session_id: string;
  /** `true` overwrites a live marker held by another session — gated behind an explicit user confirm. */
  takeover?: boolean;
}

export interface WireLeaseOpRequest {
  workflow_path: string;
  session_id: string;
}

/**
 * The `409` a lock acquire returns when a live marker is held by another session (ADR 0017): envelope plus expiry.
 */
export interface WireLockHeldBody extends WireError {
  held_by_other: true;
  expires_at: string;
}

/** `PUT /v0/workflows` request body — the write door (server-api-v0.md §7, ADR 0016). */
export interface WirePutWorkflowRequest {
  workflow_path: string;
  workflow: { [key: string]: unknown };
}

export interface WirePutWorkflowResponse {
  relative_path: string;
  id: string;
  etag: string;
}

/** The shared error envelope for every non-2xx response (server-api-v0.md §1). */
export interface WireError {
  error: {
    message: string;
    details?: JsonValue;
  };
}

/**
 * One discovered workflow file (`GET /v0/workflows`, server-api-v0.md §6). `is_root` is a presentation
 * hint, not a launchability gate (ADR 0011).
 */
export interface WorkflowSummary {
  relative_path: string;
  id: string | null;
  name: string | null;
  valid: boolean;
  is_root: boolean | null;
  error: WireError["error"] | null;
}

export interface ListWorkflowsResponse {
  workflows: WorkflowSummary[];
}

/**
 * One discovered authoring template (`GET /v0/templates`, server-api-v0.md §10.1, ADR 0050): the thin summary, no
 * `body`.
 */
export interface TemplateSummary {
  id: string | null;
  name: string;
  description: string;
  kind: "step";
  origin: "shipped" | "user";
  read_only: boolean;
  valid: boolean;
  error: WireError["error"] | null;
}

export interface ListTemplatesResponse {
  templates: TemplateSummary[];
}

/**
 * `GET /v0/templates/:id` (server-api-v0.md §10.2, ADR 0050): parsed envelope; `body` stays `unknown` for an invalid
 * template.
 */
export interface GetTemplateResponse extends Omit<TemplateSummary, "id"> {
  id: string;
  format: string | null;
  body: unknown;
  etag: string;
}

/**
 * `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050): the full object carrying the client-minted `id`.
 */
export interface WirePostTemplateRequest {
  kind: "step";
  name: string;
  description: string;
  body: Record<string, unknown>;
}

/** The `POST /v0/templates` (`201`) and `PUT /v0/templates/:id` (`200`) reply: id, written path, new ETag. */
export interface WireTemplateWriteResponse {
  id: string;
  relative_path: string;
  etag: string;
}

/** A blob name addressable via the blob route (server-api-v0.md §4.3): a run's input, output, or context. */
export type BlobName = "input" | "output" | "context";

/**
 * A camelCase field's snake_case wire name; the wire vocabulary is exactly the record's mechanical snake spelling.
 */
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);
}

/**
 * Domain record → wire, and back: both iterate `RUN_RECORD_FIELDS`, a pure rename the `as` casts carry past the
 * compiler.
 */
export function toWireRunRecord(row: RunRecord): WireRunRecord {
  const wire = {} as Record<string, unknown>;
  for (const camel of Object.keys(RUN_RECORD_FIELDS)) {
    wire[camelToSnake(camel)] = (row as unknown as Record<string, unknown>)[camel];
  }
  return wire as unknown as WireRunRecord;
}

export function fromWireRunRecord(wire: WireRunRecord): RunRecord {
  const row = {} as Record<string, unknown>;
  for (const camel of Object.keys(RUN_RECORD_FIELDS)) {
    row[camel] = (wire as unknown as Record<string, unknown>)[camelToSnake(camel)];
  }
  return row as unknown as RunRecord;
}

/**
 * Every `LaunchFacts` field, as a set: a field added to the interface is a compile error here, not one that silently
 * never crosses.
 */
const LAUNCH_FACT_FIELDS: Record<keyof LaunchFacts, true> = {
  input: true,
  config: true,
  workerDefaults: true,
  secretKeys: true,
};

/**
 * Domain → wire, and back: `undefined` fields are omitted, so a JSON response carries no null-ish key for a fact that
 * does not exist.
 */
export function toWireLaunchFacts(facts: LaunchFacts): WireLaunchFacts {
  const wire: Record<string, unknown> = {};
  for (const camel of Object.keys(LAUNCH_FACT_FIELDS)) {
    const value = (facts as unknown as Record<string, unknown>)[camel];
    if (value !== undefined) wire[camelToSnake(camel)] = value;
  }
  return wire as unknown as WireLaunchFacts;
}

export function fromWireLaunchFacts(wire: WireLaunchFacts): LaunchFacts {
  const facts: Record<string, unknown> = {};
  for (const camel of Object.keys(LAUNCH_FACT_FIELDS)) {
    const value = (wire as unknown as Record<string, unknown>)[camelToSnake(camel)];
    if (value !== undefined) facts[camel] = value;
  }
  return facts as unknown as LaunchFacts;
}

/**
 * Which `RunRecord` fields the root-run summary carries — the one statement of the projection.
 * `RootRunSummary` stays hand-written so a domain rename cannot silently rename a published v0 field.
 */
export const ROOT_RUN_SUMMARY_FIELDS = {
  runId: true,
  workflowName: true,
  workflowId: true,
  workflowPath: true,
  status: true,
  startedAt: true,
  finishedAt: true,
} as const satisfies Partial<Record<keyof RunRecord, true>>;

/**
 * The root-run summary `GET /v0/runs` returns — a projection of the full record, plus the run's masked secret keys.
 */
export function toRootRunSummary(row: RunRecord, launchSecretKeys?: string[]): RootRunSummary {
  const summary: Record<string, unknown> = {};
  for (const camel of Object.keys(ROOT_RUN_SUMMARY_FIELDS)) {
    summary[camelToSnake(camel)] = (row as unknown as Record<string, unknown>)[camel];
  }
  if (launchSecretKeys !== undefined && launchSecretKeys.length > 0)
    summary.launch_secret_keys = launchSecretKeys;
  return summary as unknown as RootRunSummary;
}
