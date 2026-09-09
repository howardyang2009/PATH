import type { JsonValue } from "./json-value.js";
import type { RunStatus } from "./run-status.js";

/**
 * One node on a **rerun boundary (K)** descent path (ADR 0032): the node's durable GUID `id` and its
 * human `name`, one entry per level root→…→K. Persisted root-only as JSON on the successor run and
 * exposed on the read wire so #418's descent crumbs read K per crumb from one clean source. For a
 * top-level K the path is length 1.
 */
export interface RerunFromNodePathEntry {
  nodeId: string;
  nodeName: string;
}

/**
 * One run, as the domain describes it (mvp spec §5.7): the authoritative queryable record of a step
 * run, in the domain's own camelCase spelling.
 *
 * This is deliberately *not* a storage shape. How a run is stored — the `runs` table, its snake_case
 * columns, the `worker_name` column and the JSON-encoded `usage` blob — belongs to `@path/engine`'s
 * run store, which maps its row type onto this one. What a run *is* belongs here, with the format
 * whose execution produces it, so that a reader with no engine (a client, a viewer) can name one.
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
  /** Null for a workflow-run's own row; a leaf step run carries the *name* of the worker it ran on (ADR 0021 sub-14). */
  workerName: string | null;
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
  /**
   * The **rerun boundary (K)** descent path this successor resumed from (ADR 0032): the node-id path
   * root→…→K as `{nodeId, nodeName}[]`, root-only, and null on plain Resume (and on every nested row).
   * A **read denormalization** — correctness never reads it, since it is re-derivable from the
   * successor's own rows — kept so #418's descent crumbs read K from one stored source. It is a
   * stored column, so every row read carries it. For a top-level K the path is length 1.
   */
  rerunFromNodePath: RerunFromNodePathEntry[] | null;
  /**
   * Set on a **reuse row** alone (#257): a resumed tree records a reused node with a real (succeeded)
   * row of its own — rather than only a log marker — and this field is the *source* run whose recorded
   * output it reuses, direct-to-source (ADR 0001), never the immediate predecessor. Null on every
   * genuinely-executed row. A reuse row carries no `usage`/`estimatedCostUsd` and no `outputRef`: its
   * output and spend live under the source run, reached through this pointer, never copied.
   */
  reusedFromRunId: string | null;
  /**
   * The root run id of the tree the reused source run lives in (#257) — the other half of the
   * provenance pair a client needs to address the source: `reusedFromRunId` names the run,
   * this names its tree. Resolved at archive read time (the source run is looked up in the global
   * store), so it rides the run-tree read the viewer renders; null on executed rows, and null on a
   * reuse row whose source tree was since `rm`'d. Not a stored column — a plain `getRun` leaves it
   * null, since only the tree read the viewer consumes needs it.
   */
  reusedFromRootRunId: string | null;
  /**
   * The producing workflow's durable GUID `id` (ADR 0006), recorded **root-only** so a central `-C`
   * store (ADR 0005) can group a run by the workflow that produced it. Null on every nested row —
   * its producing node is already named by `nodeId`/`nodeName` (#202).
   */
  workflowId: string | null;
  /** The producing workflow's human `name` (ADR 0006) — the display/filter key in `path runs list`. Root-only, null elsewhere (#202). */
  workflowName: string | null;
  /**
   * Where the producing `workflow.json` lived, as a path **relative to the store dir** (ADR 0006):
   * provenance that disambiguates two same-named workflows pooling into one `-C` store. Root-only,
   * and null when the launcher supplied no path (a server-hosted run) — the GUID/name still identify it (#202).
   */
  workflowPath: string | null;
}

/**
 * Every `RunRecord` field, as a set. This is the **one** enumeration of the record's shape: the wire
 * codec (`toWireRunRecord`/`fromWireRunRecord`), the db read (`fromDbRow`), and `blankRunRecord` all
 * iterate it, so a field added to `RunRecord` is a compile error here (the `Record<keyof RunRecord>`
 * type) and reaches every crossing from one edit — never the shotgun surgery of six hand-copies, one
 * of which the compiler could not see. The wire's snake_case name is the field's mechanical
 * snake spelling (`wire-v0.ts`, pinned by the `keyof WireRunRecord` assertion in `wire-v0.test.ts`),
 * so no per-field name pair is listed.
 */
export const RUN_RECORD_FIELDS: Record<keyof RunRecord, true> = {
  runId: true,
  rootRunId: true,
  parentRunId: true,
  nodeId: true,
  nodeName: true,
  workerName: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  inputRef: true,
  outputRef: true,
  usage: true,
  estimatedCostUsd: true,
  resumedFromRootRunId: true,
  rerunFromNodePath: true,
  reusedFromRunId: true,
  reusedFromRootRunId: true,
  workflowId: true,
  workflowName: true,
  workflowPath: true,
};

/**
 * An all-null `RunRecord` (status `pending`) with `seed` overlaid — the shape an event-created run
 * node starts as before a tree read or a `step-started`/`step-finished` fills it (view-model.ts).
 * Built from `RUN_RECORD_FIELDS`, so it can never fall out of step with the record's own fields.
 */
export function blankRunRecord(seed: Partial<RunRecord> & Pick<RunRecord, "runId" | "rootRunId">): RunRecord {
  const blank = Object.fromEntries(Object.keys(RUN_RECORD_FIELDS).map((key) => [key, null])) as unknown as RunRecord;
  return { ...blank, status: "pending", ...seed };
}
