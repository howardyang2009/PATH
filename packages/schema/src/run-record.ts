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
