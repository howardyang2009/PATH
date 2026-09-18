import type { CancelCause, Cancellation } from "./run-context.js";

/**
 * The **cancellation authorities** of a run tree (CONTEXT.md § Cancellation, mvp spec §5.6): one for
 * the root run and one for each `parallel` block, each extending the one that encloses it. This module
 * is the single place that answers the two questions every walker used to answer for itself — *is this
 * subtree coming down?* and *why?* — so a `cancelled` outcome and the `run-cancelled` cause it narrates
 * cannot disagree about which trigger stopped the run.
 *
 * The cause is **first trigger wins, read through the chain**: a block reports its own sibling cause
 * once it has one, and the nearest enclosing block's until then. Resolution is at **read time**, not
 * at block entry, because an outer sibling can fail after an inner block has started, and that failing
 * run is still the inner block's cause.
 */

/**
 * The root run's authority: an **operator abort** and nothing else. The operator's `signal` (the
 * CLI/server cancel path, `RunOptions.signal`) is chained into a controller of our own, so every block
 * below chains from one authority whose cause is known — `operator` stops being a fallback that the
 * leaf settle has to guess at.
 */
export function rootCancellation(operatorSignal?: AbortSignal): Cancellation {
  const controller = new AbortController();
  if (operatorSignal) {
    if (operatorSignal.aborted) controller.abort();
    else operatorSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return {
    signal: controller.signal,
    cause: "operator",
    causeRunId: null,
    // Nothing inside a tree triggers the root's own authority: a block cancels its own branches. These
    // exist so the type is one shape everywhere, and abort the tree if a caller ever does.
    trigger: () => controller.abort(),
    triggerWin: () => controller.abort(),
  };
}

/** A block's authority together with the handle that stops chaining it to the enclosing execution. */
export interface BlockCancellation {
  cancellation: Cancellation;
  /** Stop chaining to the outside signal — the block is done with it. */
  dispose(): void;
}

/**
 * A `parallel` block's authority, extending its enclosing one. The block's own triggers win over what
 * it inherited, and both read through to the parent until then, so an outer failing sibling is still
 * the cause of a block that never fails on its own.
 *
 * `outside` is the enclosing execution's signal: when it aborts — an outer block resolving, or the
 * operator aborting the root — this block's controller aborts too, so the block's own in-flight steps
 * are killed rather than left running under a tree that is already coming down.
 */
export function blockCancellation(parent: Cancellation | undefined, outside: AbortSignal | undefined): BlockCancellation {
  const controller = new AbortController();
  const chain = (): void => controller.abort();
  if (outside) {
    if (outside.aborted) controller.abort();
    else outside.addEventListener("abort", chain, { once: true });
  }

  let ownCause: CancelCause | null = null;
  let ownCauseRunId: string | null = null;
  return {
    cancellation: {
      signal: controller.signal,
      get cause() {
        return ownCause ?? parent?.cause ?? null;
      },
      get causeRunId() {
        // The cause and its run are read as one pair: once this block has a cause of its own, only its
        // own cause run applies. A `sibling-succeeded` win therefore reports `null` even when an outer
        // block named a failing run — a win has no cause run (wait-one-join.md §5).
        return ownCause !== null ? ownCauseRunId : (parent?.causeRunId ?? null);
      },
      trigger(causeRunId: string) {
        if (ownCause === null) {
          ownCauseRunId = causeRunId; // first failing sibling wins
          ownCause = "sibling-failed";
        }
        controller.abort();
      },
      triggerWin() {
        if (ownCause === null) {
          ownCauseRunId = null; // a win has no cause run
          ownCause = "sibling-succeeded";
        }
        controller.abort();
      },
    },
    dispose: () => {
      if (outside) outside.removeEventListener("abort", chain);
    },
  };
}

/**
 * The cause a stopped step or run narrates to its `run-cancelled` record: the authority's, or
 * `operator` when there is none. The fallback covers a caller that reaches the executor without a
 * tree (a test or an embedder building its own `RunContext`); every run the engine starts has a root
 * authority, so in production this is the authority's own answer.
 */
export function stopCause(cancellation: Cancellation | undefined): { cause: CancelCause; causeRunId: string | null } {
  return { cause: cancellation?.cause ?? "operator", causeRunId: cancellation?.causeRunId ?? null };
}
