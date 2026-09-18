import { isTerminal, type LogEvent, type RunStatus } from "@path/schema";

/**
 * The status a run moves to when one of its own events arrives, given the status it already held.
 * This is the fold the run view applies per event, and it is where the two replay rules live:
 *
 * - `step-started` walks a run to `running`, **unless it is already terminal**. A run is one executing
 *   instance (CONTEXT.md § Run), never restarted by a loop — a `while-do` pass mints a *new* run — so
 *   a full replay on reload must not walk a finished run backward and forward again, which is what
 *   made the status flicker on every open.
 * - `step-awaiting` parks a live run on `awaiting` and never reopens a terminal one: a Complete
 *   already replayed as `step-finished` is final (ADR 0041). Folding it is what makes a reload land on
 *   `awaiting` rather than leaving the parked row stuck at `running`.
 *
 * Every other event either owns no run (the control-node events) or is not this run's own record, so
 * it leaves the status alone. {@link eventOutcome} beside it answers the different question a
 * narrative row asks — what outcome does *this event* narrate — which is why it maps control events
 * too and why the two are not one function.
 */
export function runStatusAfter(prior: RunStatus, event: LogEvent): RunStatus {
  if (event.type === "step-started") return isTerminal(prior) ? prior : "running";
  if (event.type === "step-awaiting") return isTerminal(prior) ? prior : "awaiting";
  if (event.type === "step-finished") return event.status;
  return prior;
}

/**
 * Whether this event is the tree's own **root run** finishing — the moment the stream is done for
 * good (server-api-v0.md §5). The implicit root step is the root run itself, so its event carries no
 * node id and names the root run; both facts are checked here rather than re-derived from a bare
 * `node_id === null` at the stream.
 */
export function isRootRunFinished(event: LogEvent, rootRunId: string): boolean {
  return event.type === "step-finished" && event.run_id === rootRunId && event.node_id === null;
}

/**
 * The run status a log event implies, or `null` when the event only routes and asserts nothing about
 * an outcome.
 *
 * **Why this is core and not view.** Which events mean a run stopped is the engine's semantics, not
 * a rendering choice: a failed checkpoint stops the run, a branch that matched no arm with no else
 * fails it, and a while-do that exceeds its mandatory max-iterations bound fails it (CONTEXT.md,
 * *Controller* / *Checkpoint*). A branch that took an arm, an applied join and a started iteration are
 * pure control flow and get no status. A second consumer of this package — a designer's surface, a
 * mobile client — must reach the same verdicts as the web viewer, so the verdicts live on this side
 * of the seam and only their presentation stays on the other.
 */
export function eventOutcome(event: LogEvent): RunStatus | null {
  switch (event.type) {
    case "step-started":
      return "running";
    case "step-finished":
      return event.status;
    case "checkpoint-passed":
      return "succeeded";
    case "checkpoint-failed":
    case "branch-no-match":
      return "failed";
    case "run-cancelled":
      return "cancelled";
    case "loop-exited":
      return event.reason === "max-iterations-exceeded" ? "failed" : null;
    case "step-awaiting":
      return "awaiting";
    case "branch-taken":
    case "join-applied":
    case "iteration-started":
      return null;
    case "reuse-marker":
      // A reused node's recorded run succeeded originally, but the marker only points at where the
      // real record lives (#172) — it has no run row of its own here and asserts no outcome for the
      // successor tree's own progress, so it routes like the other pure-control-flow events.
      return null;
    default: {
      // Exhaustiveness guard: a new event type must decide what it means before it can render.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
