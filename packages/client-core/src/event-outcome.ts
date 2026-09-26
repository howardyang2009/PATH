import { isTerminal, type LogEvent, type RunStatus } from "@path/schema";

/** The status a run moves to when one of its own events arrives. `step-started` and `step-awaiting` never reopen a
 * terminal run, so a full replay on reload cannot walk a finished run backward.
 */
export function runStatusAfter(prior: RunStatus, event: LogEvent): RunStatus {
  if (event.type === "step-started") return isTerminal(prior) ? prior : "running";
  if (event.type === "step-awaiting") return isTerminal(prior) ? prior : "awaiting";
  if (event.type === "step-finished") return event.status;
  return prior;
}

/** Whether this event is the tree's own **root run** finishing (server-api-v0.md §5): the implicit root step carries
 * no node id.
 */
export function isRootRunFinished(event: LogEvent, rootRunId: string): boolean {
  return event.type === "step-finished" && event.run_id === rootRunId && event.node_id === null;
}

/** The run status a log event implies, or `null` for pure control flow. Engine semantics, not a rendering choice:
 * every surface must reach the same verdicts.
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
    // A goto reached with its max_jumps spent fails its pass and the workflow-run (ADR 0061).
    case "goto-exhausted":
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
    case "pass-started":
    case "goto-taken":
      return null;
    case "reuse-marker":
      // The marker only points at where the real record lives, asserting no outcome for this tree.
      return null;
    default: {
      // Exhaustiveness guard: a new event type must decide what it means before it can render.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
