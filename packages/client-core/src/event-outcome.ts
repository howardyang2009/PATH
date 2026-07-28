import type { LogEvent, RunStatus } from "@path/schema";

/**
 * The run status a log event implies, or `null` when the event only routes and asserts nothing about
 * an outcome.
 *
 * **Why this is core and not view.** Which events mean a run stopped is the engine's semantics, not
 * a rendering choice: a failed checkpoint stops the run, a branch that matched no arm with no else
 * fails it, and a while-do that exceeds its mandatory max-iterations bound fails it (CONTEXT.md,
 * *Logicer* / *Checkpoint*). A branch that took an arm, an applied join and a started iteration are
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
    case "branch-taken":
    case "join-applied":
    case "iteration-started":
      return null;
    default: {
      // Exhaustiveness guard: a new event type must decide what it means before it can render.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
