import type { ConfigObject } from "./config-value-type.js";
import type { JsonValue } from "./json-value.js";
import type { LaunchFacts } from "./launch-facts.js";
import type { LogBackendId } from "./log-backend-id.js";
import { RUN_RECORD_FIELDS, type RerunFromNodePathEntry, type RunRecord } from "./run-record.js";
import type { RunStatus } from "./run-status.js";

/**
 * The wire shapes of the `@path/server` v0 HTTP contract (docs/api/server-api-v0.md).
 *
 * One declaration, shared by both ends. Before this the record was declared once in `@path/server`
 * to encode and once in `@path/client-core` to decode, in packages with no dependency between them,
 * so the two were structurally unrelated types held in agreement by a prose comment — a field
 * renamed on one side type-checked cleanly on both and broke only at runtime, in the browser.
 *
 * Field casing is snake_case (§1), which is the whole reason a translation exists: the domain speaks
 * camelCase (`RunRecord`) and the wire speaks snake_case. `toWireRunRecord` is that translation and
 * `fromWireRunRecord` its inverse; both iterate the one `RUN_RECORD_FIELDS` manifest, so a field can
 * never survive on one side and vanish on the other. The client decodes with `fromWireRunRecord`
 * (`client-core/view-model.ts`) rather than re-listing the record's fields by hand — the copy that
 * used to reintroduce the very drift this shared shape prevents, silently, in the browser.
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
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  input_ref: string | null;
  output_ref: string | null;
  usage: JsonValue | null;
  estimated_cost_usd: number | null;
  resumed_from_root_run_id: string | null;
  /**
   * The rerun boundary (K) descent path this successor root run resumed from (ADR 0032), as
   * `{nodeId, nodeName}[]` — root-only, null on plain Resume and on every nested row. A read
   * denormalization for #418's descent crumbs; correctness never reads it.
   */
  rerun_from_node_path: RerunFromNodePathEntry[] | null;
  /** Set on a reuse row alone (#257): the source run whose output it reuses, direct-to-source. */
  reused_from_run_id: string | null;
  /** Set on a reuse row alone (#257): the root run id of the tree the source run lives in. */
  reused_from_root_run_id: string | null;
  workflow_id: string | null;
  workflow_name: string | null;
  workflow_path: string | null;
}

/**
 * The operator's frozen **launch facts** on the wire (ADR 0046), snake_case. Carried once per tree on
 * `RunTreeResponse` — they belong to the root run, not to each row — and, as `launch_secret_keys`
 * alone, on a root-run summary so a Resume surface can ask for a masked secret before it submits.
 */
export interface WireLaunchFacts {
  input?: JsonValue;
  config?: ConfigObject;
  worker_defaults?: { [stepType: string]: string };
  secret_keys?: string[];
}

/** `GET /v0/runs/:root_run_id` — run status + full tree (server-api-v0.md §4). */
export interface RunTreeResponse {
  root_run_id: string;
  status: RunStatus;
  output: JsonValue | null;
  runs: WireRunRecord[];
  /**
   * What the run was launched with (ADR 0046), absent when the launch supplied nothing beyond the
   * file. `config` is stored masked, so a `$secret` value reads as its `[secret:<key>]` token and
   * `secret_keys` names the paths that must be supplied again to continue the run.
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
  /**
   * The launch config keys this run recorded as secrets (ADR 0046) — names only, never values. Present
   * only when the launch had `$secret`-wrapped config, so a Resume surface can ask for them before it
   * submits rather than discovering them from a refusal.
   */
  launch_secret_keys?: string[];
}

/** `GET /v0/runs` — list of root runs, most recent first (server-api-v0.md §3). */
export interface ListRunsResponse {
  runs: RootRunSummary[];
}

/**
 * `POST /v0/runs` request body (server-api-v0.md §2), snake_case. Shared so the client encodes and
 * the server decodes the one shape: a body is client-encode / server-decode, the same drift mode
 * `WireRunRecord` is shared to prevent. `input`/`config` pass through as the operator authored them;
 * the server validates `config` (`ConfigObjectSchema`, rejecting `$env`) and reports a `400`.
 */
export interface StartRunRequest {
  workflow_path: string;
  input?: JsonValue;
  config?: ConfigObject;
  /**
   * The operator's run-wide **launch worker-default** table (ADR 0044, #517): `{ <type>: <name> }`,
   * a peer of `input`/`config` — deliberately **not** inside `config`, which dispatch never reads for
   * worker selection. Feeds the same engine launch table the CLI `--worker-default` fills, so an
   * HTTP-launched run resolves un-pinned steps identically to a CLI-launched one. Frozen with the run
   * like `input`, so the resume route carries no such field (changing it is a new run, not a resume).
   */
  worker_defaults?: { [stepType: string]: string };
  log_backends?: LogBackendId[];
  processor_concurrency?: number;
}

/** `POST /v0/runs` — the 202 body (server-api-v0.md §4.1). */
export interface StartRunResponse {
  run_id: string;
  root_run_id: string;
}

/**
 * `POST /v0/runs/:step_run_id/complete` request body (server-api-v0.md §4.4). The person's `output`,
 * and an optional `config` override — no status flag; the route derives the leaf and its tree from the
 * path id. The override exists because a Complete recovers the launch's frozen config (ADR 0046): a
 * value the launch stored as `$secret` is only its `[secret:<key>]` token, so this is where an operator
 * supplies it again. It carries the same ADR 0012 `$env` reject as the launch and resume bodies.
 */
export interface CompleteRunRequest {
  output: JsonValue;
  config?: ConfigObject;
}

/**
 * `POST /v0/runs/:step_run_id/complete` — the 202 body (server-api-v0.md §4.4). Echoes the leaf id the
 * caller passed and the root the server derived, so the client knows which tree's SSE stream carries
 * the continuation it should already be watching.
 */
export interface CompleteRunResponse {
  step_run_id: string;
  root_run_id: string;
}

/** The shared error envelope for every non-2xx response (server-api-v0.md §1). */
export interface WireError {
  error: {
    message: string;
    details?: JsonValue;
  };
}

/**
 * One discovered workflow file (`GET /v0/workflows`, server-api-v0.md §6). `relative_path` is the
 * launch handle — the exact string fed back as §2 `workflow_path`. `is_root` is a presentation/dedupe
 * hint, not a launchability gate (ADR 0011): `false` = also reachable as another workflow's nested
 * ref; `null` when `valid: false`. `id`/`name` are best-effort shallow-parsed and `null` when even
 * the top-level parse fails; `error` carries the shared envelope's inner shape when `valid: false`.
 */
export interface WorkflowSummary {
  relative_path: string;
  id: string | null;
  name: string | null;
  valid: boolean;
  is_root: boolean | null;
  error: WireError["error"] | null;
}

/** `GET /v0/workflows` — every discovered workflow, roots flagged (server-api-v0.md §6, ADR 0011). */
export interface ListWorkflowsResponse {
  workflows: WorkflowSummary[];
}

/**
 * A blob name addressable via the blob route (server-api-v0.md §4.3): a run's input, output, or
 * context. Only a workflow-run seeds a `context.json` (format §6.3); a leaf step has none, so a
 * `context` read for one answers 404 like any other absent object.
 */
export type BlobName = "input" | "output" | "context";

/**
 * A camelCase field's snake_case wire name. The wire contract is exactly the record's mechanical
 * snake spelling (pinned by `wire-v0.test.ts`'s `keyof WireRunRecord` assertion), so this one
 * transform derives every name — no hand-listed pair to drift. Every `RunRecord` key is letters only.
 */
function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (upper) => `_${upper.toLowerCase()}`);
}

/**
 * Domain record → wire, and back. Both iterate `RUN_RECORD_FIELDS`, copying each field under its
 * camel (domain) or snake (wire) name. Per-field value types are identical across the two shapes
 * (both `JsonValue | null`, `string | null`, …), so the copy is a pure rename — the `as` casts carry
 * the rename past the compiler, which has already checked the field set is complete.
 */
export function toWireRunRecord(row: RunRecord): WireRunRecord {
  const wire = {} as Record<string, unknown>;
  for (const camel of Object.keys(RUN_RECORD_FIELDS)) {
    wire[camelToSnake(camel)] = (row as unknown as Record<string, unknown>)[camel];
  }
  return wire as unknown as WireRunRecord;
}

/** Wire → domain record — the inverse the client decodes with (`view-model.ts`). */
export function fromWireRunRecord(wire: WireRunRecord): RunRecord {
  const row = {} as Record<string, unknown>;
  for (const camel of Object.keys(RUN_RECORD_FIELDS)) {
    row[camel] = (wire as unknown as Record<string, unknown>)[camelToSnake(camel)];
  }
  return row as unknown as RunRecord;
}

/**
 * Every `LaunchFacts` field, as a set — the one enumeration the launch-facts codec iterates, the same
 * discipline `RUN_RECORD_FIELDS` gives the record. Four fields, but a fifth added to the interface is
 * a compile error here rather than a field that silently never crosses.
 */
const LAUNCH_FACT_FIELDS: Record<keyof LaunchFacts, true> = {
  input: true,
  config: true,
  workerDefaults: true,
  secretKeys: true,
};

/**
 * Domain → wire, and back, omitting fields the launch never supplied. `undefined` is left out rather
 * than copied, so a JSON response carries no null-ish key for a fact that does not exist — only a
 * launch that actually supplied something has a `launch_facts` to show.
 */
export function toWireLaunchFacts(facts: LaunchFacts): WireLaunchFacts {
  const wire: Record<string, unknown> = {};
  for (const camel of Object.keys(LAUNCH_FACT_FIELDS)) {
    const value = (facts as unknown as Record<string, unknown>)[camel];
    if (value !== undefined) wire[camelToSnake(camel)] = value;
  }
  return wire as unknown as WireLaunchFacts;
}

/** Wire → domain launch facts — the inverse the client decodes with. */
export function fromWireLaunchFacts(wire: WireLaunchFacts): LaunchFacts {
  const facts: Record<string, unknown> = {};
  for (const camel of Object.keys(LAUNCH_FACT_FIELDS)) {
    const value = (wire as unknown as Record<string, unknown>)[camelToSnake(camel)];
    if (value !== undefined) facts[camel] = value;
  }
  return facts as unknown as LaunchFacts;
}

/**
 * The root-run summary `GET /v0/runs` returns — a projection of the full record, not a new shape.
 * `launchSecretKeys` rides beside it because the summary is what a Resume surface lists: a parked or
 * failed run's masked secrets have to be asked for before the submit, and the row itself does not
 * hold them (they live in the tree's `launch_facts`).
 */
export function toRootRunSummary(row: RunRecord, launchSecretKeys?: string[]): RootRunSummary {
  return {
    run_id: row.runId,
    workflow_name: row.workflowName,
    workflow_id: row.workflowId,
    workflow_path: row.workflowPath,
    status: row.status,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    ...(launchSecretKeys !== undefined && launchSecretKeys.length > 0 ? { launch_secret_keys: launchSecretKeys } : {}),
  };
}
