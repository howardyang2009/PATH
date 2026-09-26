import type { CancelCause, Cancellation } from "./run-context.js";

/**
 * The cancellation authorities of a run tree: one for the root run and one per `parallel` block, each
 * extending its enclosing one. Cause is first trigger wins, read at read time since an outer sibling
 * can fail after an inner block starts.
 */

/** The root run's authority: an operator abort only; the operator's signal is chained into our controller. */
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
    // No in-tree trigger reaches the root's own authority; both exist so the type is one shape.
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
 * A `parallel` block's authority: its own triggers win, otherwise it reads through to the parent.
 * `outside` aborts this block when the enclosing execution comes down.
 */
export function blockCancellation(
  parent: Cancellation | undefined,
  outside: AbortSignal | undefined,
): BlockCancellation {
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
        // Cause and cause run are one pair: a block's own cause wins, and a win has no cause run (§5).
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

/** The cause a stopped step narrates: the authority's, or `operator` for a caller that brought no tree. */
export function stopCause(cancellation: Cancellation | undefined): {
  cause: CancelCause;
  causeRunId: string | null;
} {
  return { cause: cancellation?.cause ?? "operator", causeRunId: cancellation?.causeRunId ?? null };
}
