import type { LogEvent } from "@path/schema";
import { nodeEventLabel } from "./node-label.js";

/** One log event as one line of the narrative; every branch is exhaustive over the `LogEvent` union, so a new event
 * type is a compile error. A `trace` is per-predicate and does not fit one dense line, so it is never rendered.
 */
export function eventMessage(event: LogEvent): string {
  const label = nodeEventLabel(event.node_id, event.node_name);
  switch (event.type) {
    case "step-started":
      return `${label} started · ${event.worker_name}`;
    case "step-awaiting":
      return `${label} awaiting completion`;
    case "step-finished":
      // The `error` tail carries the exit code + a short stderr tail on a binary step (mvp spec §8.1).
      return event.error === undefined
        ? `${label} ${event.status}`
        : `${label} ${event.status} · ${event.error}`;
    case "checkpoint-passed":
      return `checkpoint ${label} passed`;
    case "checkpoint-failed":
      return `checkpoint ${label} failed`;
    case "branch-taken":
      // The fallback arm has no index and no condition — naming it "arm else" would read as an index.
      return event.arm === "else"
        ? `branch ${label} took the else arm`
        : `branch ${label} took arm ${event.arm}`;
    case "branch-no-match":
      return `branch ${label} matched no arm`;
    case "join-applied": {
      const published =
        event.published_keys.length > 0 ? ` · published ${event.published_keys.join(", ")}` : "";
      return `join ${label} applied · branches ${event.branches.join(", ")}${published}`;
    }
    case "run-cancelled":
      // The operator cause carries no sibling run; naming one for it would print a lie.
      return event.cause === "operator"
        ? `${label} cancelled by the operator`
        : `${label} cancelled · cause ${event.cause_run_id}`;
    case "iteration-started":
      return `while-do ${label} iteration ${event.iteration}`;
    case "loop-exited":
      return `while-do ${label} exited after ${event.iterations} iterations · ${event.reason}`;
    case "pass-started":
      // Pass 1 has no opening goto, so it names only its ordinal.
      return event.node_id === null
        ? `pass ${event.pass}`
        : `pass ${event.pass} opened by goto ${label}`;
    case "goto-taken":
      return `goto ${label} jumped to ${event.target_node_name} · jump ${event.jump}/${event.max_jumps} · pass ${event.pass}`;
    case "goto-exhausted":
      return `goto ${label} exhausted · max_jumps ${event.max_jumps} · target ${event.target_node_name}`;
    case "reuse-marker":
      // A resumed run reused this node's recorded work; the pointer is where the real record lives.
      return `${label} reused from ${event.original_run_id}`;
    default: {
      // Exhaustiveness guard: adding a member to the union fails to compile until it is handled.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
