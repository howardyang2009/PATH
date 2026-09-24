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

/**
 * The edit lease's JSON (`POST /v0/workflows/lock` and `.../heartbeat` replies, and the `.editing`
 * marker on disk), server-authored and snake_case (server-api-v0.md §7.2, ADR 0017).
 *
 * Shared because it is a body the server **writes** and the client **reads**: `@path/server` used to
 * declare it as a private `Lease` and `@path/client-core` as `WorkflowLease`, verbatim copies in
 * packages with no dependency between them — the drift mode this module exists to prevent. The
 * client's `WorkflowLease` is now an alias of this, so one rename reaches both ends.
 *
 * `session_id` is client-minted (a UUIDv4, ADR 0015's client-mints-identity stance) and the only token
 * a client presents. `acquired_at`/`heartbeat_at` are server-stamped, and `expires_at = heartbeat_at +
 * TTL` is server-computed — never read from the client (a client-set expiry could pin a lease forever).
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

/** `POST /v0/workflows/lock/heartbeat` and `.../release` request body — renew or free (ADR 0017). */
export interface WireLeaseOpRequest {
  workflow_path: string;
  session_id: string;
}

/**
 * The `409` a lock acquire returns when a **live** marker is held by another session (ADR 0017) — the
 * shared error envelope plus the holder's expiry and the flag the client branches on. A normal outcome
 * for the caller, not an error: the UI counts the expiry down and offers a confirmation-gated takeover.
 */
export interface WireLockHeldBody extends WireError {
  held_by_other: true;
  expires_at: string;
}

/** `PUT /v0/workflows` request body — the write door (server-api-v0.md §7, ADR 0016). */
export interface WirePutWorkflowRequest {
  workflow_path: string;
  /** The workflow object as authored (snake_case wire); the server preserves its key order. */
  workflow: { [key: string]: unknown };
}

/** `PUT /v0/workflows` reply — the written path, its workflow `id`, and the new strong `ETag`. */
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
 * One discovered authoring template (`GET /v0/templates`, server-api-v0.md §10.1, ADR 0050 decision 4):
 * the **thin** summary, no `body`. `name` is the file stem and the palette label; `description` is the
 * palette blurb. `valid`/`error` are registry-relative per entry, so a broken template still lists.
 */
export interface TemplateSummary {
  id: string | null;
  name: string;
  description: string;
  kind: "step" | "workflow";
  origin: "shipped" | "user";
  read_only: boolean;
  valid: boolean;
  error: WireError["error"] | null;
}

/** `GET /v0/templates` — the shipped∪user template union, both kinds unless `?kind=` narrows it. */
export interface ListTemplatesResponse {
  templates: TemplateSummary[];
}

/**
 * `GET /v0/templates/:id` — one template as a **parsed envelope** (server-api-v0.md §10.2, ADR 0050
 * decision 5). `body` is a step-template's `WorkflowNode[]` or a workflow-template's whole workflow
 * file; it is best-effort for an invalid template (`valid: false`), so it stays `unknown` on the wire.
 * `etag` is the sha256 of the on-disk bytes, the `If-Match` value for a later update.
 */
export interface GetTemplateResponse extends Omit<TemplateSummary, "id"> {
  id: string;
  format: string | null;
  body: unknown;
  etag: string;
}

/**
 * `POST /v0/templates` — save-as (server-api-v0.md §10.3, ADR 0050 decision 6). `body` is the full
 * template object (a step-template envelope or a whole workflow file) carrying the client-minted `id`;
 * `name` is the file stem and `kind` picks the suffix, so neither lives in the written bytes.
 */
export interface WirePostTemplateRequest {
  kind: "step" | "workflow";
  name: string;
  description: string;
  body: Record<string, unknown>;
}

/**
 * The `POST /v0/templates` (`201`) and `PUT /v0/templates/:id` (`200`) reply (server-api-v0.md §10.3,
 * §10.4): the template id, the written path under the project root, and the new ETag.
 */
export interface WireTemplateWriteResponse {
  id: string;
  relative_path: string;
  etag: string;
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
 * Which `RunRecord` fields the root-run summary carries, as the record's own key names — the **one**
 * statement of the projection. `RootRunSummary` stays written out by hand (below), because a derived
 * wire type would let a domain rename silently rename a field of the published v0 API; this list is
 * what `toRootRunSummary` iterates, and `wire-v0.test.ts` pins that its snake spelling is exactly the
 * summary's keys. Before this, the projection hand-listed the same seven names a second time, one
 * rename away from a summary that silently carried `null`.
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
 * The root-run summary `GET /v0/runs` returns — a projection of the full record, not a new shape.
 * `launchSecretKeys` rides beside it because the summary is what a Resume surface lists: a parked or
 * failed run's masked secrets have to be asked for before the submit, and the row itself does not
 * hold them (they live in the tree's `launch_facts`).
 */
export function toRootRunSummary(row: RunRecord, launchSecretKeys?: string[]): RootRunSummary {
  const summary: Record<string, unknown> = {};
  for (const camel of Object.keys(ROOT_RUN_SUMMARY_FIELDS)) {
    summary[camelToSnake(camel)] = (row as unknown as Record<string, unknown>)[camel];
  }
  if (launchSecretKeys !== undefined && launchSecretKeys.length > 0) summary.launch_secret_keys = launchSecretKeys;
  return summary as unknown as RootRunSummary;
}
