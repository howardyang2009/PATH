import type { LogEvent, RunStatus } from "@path/client-core";

/**
 * The run status a log event implies, or `null` when the event only routes and asserts nothing about
 * an outcome. This is what lets the narrative carry a status **glyph plus color** per row rather than
 * hue alone (#44 accessibility decision) — and it is why a failed step is findable while scrolling a
 * long stream, not just readable once found.
 *
 * The failure mappings follow the engine's own semantics: a failed checkpoint stops the run, a branch
 * that matches no arm with no else fails it, and a while-do that exceeds its max-iterations bound
 * fails it (CONTEXT.md, *Logicer* / *Checkpoint*). A branch that took an arm, an applied join and a
 * started iteration are pure control flow — they get no status.
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
