import { type Message, verbatim } from "@path/i18n";
import type { LogEvent } from "@path/schema";
import { nodeEventLabel } from "./node-label.js";

/** One log event as one line of the narrative; every branch is exhaustive over the `LogEvent`
 * union, so a new event type is a compile error. A `trace` is per-predicate and does not fit one
 * dense line, so it is never rendered.
 */
export function eventMessage(event: LogEvent): Message {
  const label = nodeEventLabel(event.node_id, event.node_name);
  switch (event.type) {
    case "step-started":
      return { key: "events.stepStarted", params: { label, worker: event.worker_name } };
    case "step-awaiting":
      return { key: "events.stepAwaiting", params: { label } };
    case "step-finished": {
      const status: Message = { key: `shared.status.${event.status}` };
      // The `error` tail carries the exit code + a short stderr tail on a binary step (mvp spec
      // §8.1); it is the engine's English until run events carry error codes.
      return event.error === undefined
        ? { key: "events.stepFinished", params: { label, status } }
        : {
            key: "events.stepFinishedError",
            params: { label, status, error: verbatim(event.error) },
          };
    }
    case "checkpoint-passed":
      return { key: "events.checkpointPassed", params: { label } };
    case "checkpoint-failed":
      return { key: "events.checkpointFailed", params: { label } };
    case "branch-taken":
      // The fallback arm has no index and no condition — naming it "arm else" would read as an
      // index.
      return event.arm === "else"
        ? { key: "events.branchTookElse", params: { label } }
        : { key: "events.branchTookArm", params: { label, arm: event.arm } };
    case "branch-no-match":
      return { key: "events.branchNoMatch", params: { label } };
    case "join-applied": {
      const branches = event.branches.join(", ");
      return event.published_keys.length > 0
        ? {
            key: "events.joinAppliedPublished",
            params: { label, branches, keys: event.published_keys.join(", ") },
          }
        : { key: "events.joinApplied", params: { label, branches } };
    }
    case "run-cancelled":
      // The operator cause carries no sibling run; naming one for it would print a lie.
      return event.cause === "operator"
        ? { key: "events.cancelledByOperator", params: { label } }
        : { key: "events.cancelledByRun", params: { label, causeRunId: event.cause_run_id ?? "" } };
    case "iteration-started":
      return { key: "events.iterationStarted", params: { label, iteration: event.iteration } };
    case "loop-exited":
      return {
        key: "events.loopExited",
        params: {
          label,
          iterations: event.iterations,
          reason: {
            key:
              event.reason === "condition-false"
                ? "events.loopExitReason.conditionFalse"
                : "events.loopExitReason.maxIterationsExceeded",
          },
        },
      };
    case "pass-started":
      // Pass 1 has no opening goto, so it names only its ordinal.
      return event.node_id === null
        ? { key: "events.passStarted", params: { pass: event.pass } }
        : { key: "events.passOpenedBy", params: { pass: event.pass, label } };
    case "goto-taken":
      return {
        key: "events.gotoTaken",
        params: {
          label,
          target: event.target_node_name,
          jump: event.jump,
          maxJumps: event.max_jumps,
          pass: event.pass,
        },
      };
    case "goto-exhausted":
      return {
        key: "events.gotoExhausted",
        params: { label, maxJumps: event.max_jumps, target: event.target_node_name },
      };
    case "reuse-marker":
      // A resumed run reused this node's recorded work; the pointer is where the real record lives.
      return { key: "events.reuseMarker", params: { label, originalRunId: event.original_run_id } };
    default: {
      // Exhaustiveness guard: adding a member to the union fails to compile until it is handled.
      const unhandled: never = event;
      return unhandled;
    }
  }
}
