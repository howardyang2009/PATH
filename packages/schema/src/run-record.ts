import type { JsonValue } from "./json-value.js";
import type { RunStatus } from "./run-status.js";

/**
 * One node on a **rerun boundary (K)** descent path (ADR 0032): durable `id` and human `name`, root-only, one entry
 * per level root→…→K.
 */
export interface RerunFromNodePathEntry {
  nodeId: string;
  nodeName: string;
  /** The goto pass K sits in at this level (ADR 0054 §6); present only when this level's file holds a goto. */
  pass?: number;
}

/**
 * One run as the domain describes it (mvp spec §5.7) — the authoritative queryable record, not a storage shape; the
 * `runs` table's snake_case mapping belongs to the engine's run store. `usage`/`estimatedCostUsd` are leaf-only,
 * since subtree spend is a read-time SUM.
 */
export interface RunRecord {
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  nodeId: string | null;
  nodeName: string | null;
  workerName: string | null;
  /**
   * The 1-based `while-do` iteration container ordinal (ADR 0037); the container is worker-less but shares the loop's
   * context.
   */
  iteration: number | null;
  /**
   * The 1-based goto **pass** container ordinal (ADR 0054); only a file holding a goto has passes, and pass 1 names
   * no goto.
   */
  pass: number | null;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  inputRef: string | null;
  outputRef: string | null;
  usage: JsonValue | null;
  estimatedCostUsd: number | null;
  resumedFromRootRunId: string | null;
  /**
   * The rerun-boundary descent path root→…→K this successor resumed from (ADR 0032); a read denormalization, null on
   * plain Resume.
   */
  rerunFromNodePath: RerunFromNodePathEntry[] | null;
  /**
   * Set on a **reuse row** alone: the source run whose recorded output it reuses — direct-to-source (ADR 0001), never
   * the predecessor.
   */
  reusedFromRunId: string | null;
  /** The reused source's tree root, resolved at tree-read time — not a stored column; null on executed rows. */
  reusedFromRootRunId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  workflowPath: string | null;
}

// The one enumeration of the record's shape: the wire codec, the db read, and `blankRunRecord` all iterate
// it, so a field added to `RunRecord` is a compile error here and reaches every crossing.
export const RUN_RECORD_FIELDS: Record<keyof RunRecord, true> = {
  runId: true,
  rootRunId: true,
  parentRunId: true,
  nodeId: true,
  nodeName: true,
  workerName: true,
  iteration: true,
  pass: true,
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

/** An all-null `RunRecord` (status `pending`) with `seed` overlaid, built from `RUN_RECORD_FIELDS`. */
export function blankRunRecord(
  seed: Partial<RunRecord> & Pick<RunRecord, "runId" | "rootRunId">,
): RunRecord {
  const blank = Object.fromEntries(
    Object.keys(RUN_RECORD_FIELDS).map((key) => [key, null]),
  ) as unknown as RunRecord;
  return { ...blank, status: "pending", ...seed };
}
