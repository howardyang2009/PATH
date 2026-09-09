/**
 * The kind of a run row (#257 grew the set to four; #454 to five). A `runs` row is a flat struct
 * standing in for a sum type: root run, nested workflow-run, leaf step, reuse row, or a `while-do`
 * iteration container. "Which kind" used to be re-derived by scattered null-checks — `parentRunId ===
 * null` for root, `reusedFromRunId !== null` for reuse — restated at every reader and across the
 * engine/client seam. The three type-guards below are where each distinction now lives — one reader of
 * `parentRunId`, one of `reusedFromRunId`, one of `iteration` — so a reader narrows through the guard
 * instead of re-writing its null-check. The five kinds a `runs` row stands in for:
 *
 * - **root** — the tree's top run, no parent (its own id is the root run id). A workflow-run.
 * - **nested-workflow** — a `workflow` step's run, spawned under a parent (workflow-as-step). Also a
 *   workflow-run, so it carries no worker of its own.
 * - **leaf** — a `binary`/`prompt` step run, the only kind bound to a worker.
 * - **reuse** — a resumed tree's pointer row: owns no execution, names the source run it reused.
 * - **iteration** — one pass of a `while-do` loop (ADR 0037, #454): a run scope minted per iteration so
 *   the loop body's runs get a unique parent, restoring `(scope, node id)` uniqueness across iterations
 *   for Resume reuse. Worker-less like a workflow-run, but it does *not* isolate context — the loop's
 *   shared blackboard is the enclosing run's — so it is its own kind, told apart by `iteration` being set.
 */

/** The fields a run's kind is read from — a `RunRecord` or a client-side `RunNodeState` fits. */
export interface RunKindFields {
  parentRunId: string | null;
  reusedFromRunId: string | null;
  workerName: string | null;
  /** 1-based ordinal on a `while-do` iteration container (ADR 0037), null on every other kind. */
  iteration: number | null;
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
 * A `while-do` iteration container (ADR 0037): a run scope minted once per loop pass, told apart by its
 * 1-based `iteration` ordinal, which no other kind carries. A type guard, so the branch that knows a
 * row is an iteration also knows its `iteration` is set.
 */
export function isIterationRun<T extends Pick<RunKindFields, "iteration">>(run: T): run is T & { iteration: number } {
  return run.iteration !== null;
}
