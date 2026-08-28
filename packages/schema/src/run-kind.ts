/**
 * The kind of a run row (#257 grew the set to four). A `runs` row is a flat struct standing in for a
 * sum type: root run, nested workflow-run, leaf step, or reuse row. "Which kind" used to be re-derived
 * by scattered null-checks — `parentRunId === null` for root, `reusedFromRunId !== null` for reuse —
 * restated at every reader and across the engine/client seam. This is the one place that classifies.
 *
 * - **root** — the tree's top run, no parent (its own id is the root run id). A workflow-run.
 * - **nested-workflow** — a `workflow` step's run, spawned under a parent (workflow-as-step). Also a
 *   workflow-run, so it carries no worker of its own.
 * - **leaf** — a `binary`/`prompt` step run, the only kind bound to a worker.
 * - **reuse** — a resumed tree's pointer row: owns no execution, names the source run it reused.
 */
export type RunKind = "root" | "nested-workflow" | "leaf" | "reuse";

/** The three fields a run's kind is read from — a `RunRecord` or a client-side `RunNodeState` fits. */
export interface RunKindFields {
  parentRunId: string | null;
  reusedFromRunId: string | null;
  workerName: string | null;
}

/**
 * A reuse row (#257): a pointer to a source run's recorded work, owning no execution of its own. A
 * type guard, so the branch that knows a row is a reuse row also knows its `reusedFromRunId` is set.
 */
export function isReuseRow<T extends Pick<RunKindFields, "reusedFromRunId">>(
  run: T,
): run is T & { reusedFromRunId: string } {
  return run.reusedFromRunId !== null;
}

/** The tree's top run (invariant 2): no parent, so its own id is the root run id. A type guard. */
export function isRootRun<T extends Pick<RunKindFields, "parentRunId">>(run: T): run is T & { parentRunId: null } {
  return run.parentRunId === null;
}

/**
 * Classify one run row. Reuse is tested first (a reuse row has a parent, so it must not read as root
 * or leaf); then root; then the worker name distinguishes a nested workflow-run (none — workflow-runs
 * carry no worker) from a leaf step (bound to one). Every worker-less non-root non-reuse row is a
 * nested workflow-run, so the fall-through to `leaf` is reached only for a real worker-bound step.
 */
export function runKind(run: RunKindFields): RunKind {
  if (isReuseRow(run)) return "reuse";
  if (isRootRun(run)) return "root";
  return run.workerName === null ? "nested-workflow" : "leaf";
}
