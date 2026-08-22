import type { LogEvent } from "@path/client-core";
import { nodeEventLabel } from "./node-label.js";

/**
 * One log event as one line of the narrative — the presentation half of the log stream (the ordering
 * and dedupe are the view-model's job, on the other side of the seam). Every branch is exhaustive
 * over the `LogEvent` union so a new event type is a compile error here, not a blank row.
 *
 * Condition traces are deliberately not rendered: a `trace` is a per-predicate record (CONTEXT.md,
 * *Trace*) that does not fit one dense line. The verdict is what a watcher reads in the stream.
 */
export function eventMessage(event: LogEvent): string {
  const label = nodeEventLabel(event.node_id, event.node_name);
  switch (event.type) {
    case "step-started":
      return `${label} started · ${event.worker.type}`;
    case "step-finished":
      // The `error` tail carries the exit code + a short stderr tail on a binary step (mvp spec §8.1).
      return event.error === undefined ? `${label} ${event.status}` : `${label} ${event.status} · ${event.error}`;
    case "checkpoint-passed":
      return `checkpoint ${label} passed`;
    case "checkpoint-failed":
      return `checkpoint ${label} failed`;
    case "branch-taken":
      // The fallback arm has no index and no condition — naming it "arm else" would read as an index.
      return event.arm === "else" ? `branch ${label} took the else arm` : `branch ${label} took arm ${event.arm}`;
    case "branch-no-match":
      return `branch ${label} matched no arm`;
    case "join-applied": {
      const published = event.published_keys.length > 0 ? ` · published ${event.published_keys.join(", ")}` : "";
      return `join ${label} applied · branches ${event.branches.join(", ")}${published}`;
    }
    case "run-cancelled":
      // The operator cause carries no sibling run (#56); naming one for it would print a lie.
      return event.cause === "operator"
        ? `${label} cancelled by the operator`
        : `${label} cancelled · cause ${event.cause_run_id}`;
    case "iteration-started":
      return `while-do ${label} iteration ${event.iteration}`;
    case "loop-exited":
      return `while-do ${label} exited after ${event.iterations} iterations · ${event.reason}`;
    case "reuse-marker":
      // A resumed run reused this node's recorded work (#172); the pointer is where the real record
      // lives, so a watcher can follow it rather than hit a silent gap in the narrative.
      return `${label} reused from ${event.original_run_id}`;
    default: {
      // Exhaustiveness guard: adding a member to the union fails to compile until it is handled.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
