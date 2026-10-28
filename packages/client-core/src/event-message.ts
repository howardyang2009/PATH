import { decodeError, type Message } from "@path/i18n";
import type { LogEvent, StepFinishedEvent } from "@path/schema";
import { nodeEventLabel } from "./node-label.js";

/** One log event as one line of the narrative; every branch is exhaustive over the `LogEvent`
 * union, so a new event type is a compile error. A `trace` is per-predicate and does not fit one
 * dense line, so it is never rendered.
 */
export function eventMessage(event: LogEvent): Message {
  const label = nodeEventLabel(event.node_id, event.node_name);
  switch (event.type) {
    case "step-started":
      return {
        key: "events.narrative.stepStarted",
        params: { label, workerName: event.worker_name },
      };
    case "step-awaiting":
      return { key: "events.narrative.stepAwaiting", params: { label } };
    case "step-finished": {
      const status: Message = { key: `shared.status.${event.status}` };
      const error = stepFinishedError(event);
      return error === undefined
        ? { key: "events.narrative.stepFinished", params: { label, status } }
        : { key: "events.narrative.stepFinishedError", params: { label, status, error } };
    }
    case "checkpoint-passed":
      return { key: "events.narrative.checkpointPassed", params: { label } };
    case "checkpoint-failed":
      return { key: "events.narrative.checkpointFailed", params: { label } };
    case "branch-taken":
      // The fallback arm has no index and no condition — naming it "arm else" would read as an
      // index.
      return event.arm === "else"
        ? { key: "events.narrative.branchTookElse", params: { label } }
        : { key: "events.narrative.branchTookArm", params: { label, arm: event.arm } };
    case "branch-no-match":
      return { key: "events.narrative.branchNoMatch", params: { label } };
    case "join-applied": {
      const branches = event.branches.join(", ");
      return event.published_keys.length > 0
        ? {
            key: "events.narrative.joinAppliedPublished",
            params: { label, branches, publishedKeys: event.published_keys.join(", ") },
          }
        : { key: "events.narrative.joinApplied", params: { label, branches } };
    }
    case "run-cancelled":
      // The operator cause carries no sibling run; naming one for it would print a lie.
      return event.cause === "operator"
        ? { key: "events.narrative.cancelledByOperator", params: { label } }
        : {
            key: "events.narrative.cancelledByRun",
            params: { label, causeRunId: event.cause_run_id ?? "" },
          };
    case "iteration-started":
      return {
        key: "events.narrative.iterationStarted",
        params: { label, iteration: event.iteration },
      };
    case "loop-exited":
      return {
        key: "events.narrative.loopExited",
        params: {
          label,
          iterations: event.iterations,
          reason: {
            key:
              event.reason === "condition-false"
                ? "events.narrative.loopExitReason.conditionFalse"
                : "events.narrative.loopExitReason.maxIterationsExceeded",
          },
        },
      };
    case "pass-started":
      // Pass 1 has no opening goto, so it names only its ordinal.
      return event.node_id === null
        ? { key: "events.narrative.passStarted", params: { pass: event.pass } }
        : { key: "events.narrative.passOpenedBy", params: { pass: event.pass, label } };
    case "goto-taken":
      return {
        key: "events.narrative.gotoTaken",
        params: {
          label,
          targetNodeName: event.target_node_name,
          jump: event.jump,
          maxJumps: event.max_jumps,
          pass: event.pass,
        },
      };
    case "goto-exhausted":
      return {
        key: "events.narrative.gotoExhausted",
        params: { label, maxJumps: event.max_jumps, targetNodeName: event.target_node_name },
      };
    case "reuse-marker":
      // A resumed run reused this node's recorded work; the pointer is where the real record lives.
      return {
        key: "events.narrative.reuseMarker",
        params: { label, originalRunId: event.original_run_id },
      };
    default: {
      // Exhaustiveness guard: adding a member to the union fails to compile until it is handled.
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/** A step's failure as the UI shows it (ADR 0107 point 4): a known `error_code` from the
 * catalogue, else the stored English, as for an event written before codes. */
export function stepFinishedError(event: StepFinishedEvent): Message | undefined {
  if (event.error === undefined) return undefined;
  return decodeError(event.error_code, event.error_params, event.error);
}
