/**
 * The six kinds a `runs` row stands in for: root, nested-workflow, leaf, reuse, `while-do` iteration container, and
 * goto pass container — each distinction lives in exactly one type guard below.
 */

/** The fields a run's kind is read from — a `RunRecord` or a client-side `RunNodeState` fits. */
export interface RunKindFields {
  parentRunId: string | null;
  reusedFromRunId: string | null;
  workerName: string | null;
  iteration: number | null;
  pass: number | null;
}

/** A reuse row: a pointer to a source run's recorded work, owning no execution of its own. */
export function isReuseRow<T extends Pick<RunKindFields, "reusedFromRunId">>(
  run: T,
): run is T & { reusedFromRunId: string } {
  return run.reusedFromRunId !== null;
}

export function isRootRun<T extends Pick<RunKindFields, "parentRunId">>(
  run: T,
): run is T & { parentRunId: null } {
  return run.parentRunId === null;
}

/**
 * A `while-do` iteration container (ADR 0037): a run scope minted per loop pass, told apart by its 1-based
 * `iteration` ordinal.
 */
export function isIterationRun<T extends Pick<RunKindFields, "iteration">>(
  run: T,
): run is T & { iteration: number } {
  return run.iteration !== null;
}

/**
 * A goto pass container (ADR 0054): one forward stretch of a goto-holding file's top-level walk, told apart by its
 * 1-based `pass` ordinal.
 */
export function isPassRun<T extends Pick<RunKindFields, "pass">>(
  run: T,
): run is T & { pass: number } {
  return run.pass !== null;
}
