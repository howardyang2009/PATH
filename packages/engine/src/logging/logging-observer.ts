import { type LogEvent, LogEventSchema } from "@path/schema";
import {
  type Observation,
  ObserverError,
  type RunObserver,
  type RunOutcome,
} from "../run-observer.js";
import { LOG_FORMAT, type LogBackend } from "./log-backend.js";

// A workflow-run is its file's implicit root step, so its lifecycle events report this step_type.
const WORKFLOW_STEP_TYPE = "workflow";

// A backend plus its bookkeeping: `active` drops it after a write failure while the survivors still
// get terminal events, and `tail` is its one write queue (mvp spec §8.2).
interface ManagedBackend {
  backend: LogBackend;
  active: boolean;
  tail: Promise<void>;
}

/** The shared log-event envelope (mvp spec §8.1); `seq` is the ordering truth per root run. */
type Envelope = {
  seq: number;
  ts: string;
  run_id: string;
  node_id: string | null;
  node_name: string | null;
};

type NodeIdentity = { id: string; name: string };

// A `cancelled` step-finished carries no error — the cause is narrated by run-cancelled.
function finishedEvent(env: Envelope, outcome: RunOutcome): LogEvent {
  return outcome.status === "failed" && outcome.error !== undefined
    ? { type: "step-finished", ...env, status: "failed", error: outcome.error }
    : { type: "step-finished", ...env, status: outcome.status };
}

/**
 * Project one observation onto the log narrative, or `null` when it is not narrated. Payloads are
 * dropped (`input`/`output`/`context` reach the log only as blob refs, mvp spec §6); four observations
 * are persistence-only and return `null`; and the shapes are not 1:1 — `run-started` and
 * `step-started` both become `step-started`, as do `run-finished` and `step-finished`, while
 * `checkpoint-evaluated` splits in two. The `never` guard forces a decision on each new member.
 * `envelope` is a factory because the choice of `node_id`/`node_name` is part of the projection.
 */
export function toLogEvent(
  o: Observation,
  envelope: (o: Observation) => Envelope,
): LogEvent | null {
  switch (o.type) {
    case "run-started":
      // Its `worker_name` is the step type itself, the one string a workflow-shaped step can name.
      return {
        type: "step-started",
        ...envelope(o),
        step_type: WORKFLOW_STEP_TYPE,
        worker_name: WORKFLOW_STEP_TYPE,
      };
    case "step-started":
      return {
        type: "step-started",
        ...envelope(o),
        step_type: o.stepType,
        worker_name: o.workerName,
      };
    case "step-finished":
    case "run-finished":
      return finishedEvent(envelope(o), o);
    case "checkpoint-evaluated":
      return {
        type: o.passed ? "checkpoint-passed" : "checkpoint-failed",
        ...envelope(o),
        trace: o.trace,
      };
    case "branch-taken":
      return { type: "branch-taken", ...envelope(o), arm: o.arm, trace: o.trace };
    case "branch-no-match":
      return { type: "branch-no-match", ...envelope(o), traces: o.traces };
    case "iteration-started":
      return { type: "iteration-started", ...envelope(o), iteration: o.iteration, trace: o.trace };
    case "loop-exited":
      return {
        type: "loop-exited",
        ...envelope(o),
        reason: o.reason,
        iterations: o.iterations,
        trace: o.trace,
      };
    case "pass-started":
      return { type: "pass-started", ...envelope(o), pass: o.pass };
    case "goto-taken":
      return {
        type: "goto-taken",
        ...envelope(o),
        target_node_id: o.targetNodeId,
        target_node_name: o.targetNodeName,
        jump: o.jump,
        max_jumps: o.maxJumps,
        pass: o.pass,
      };
    case "goto-exhausted":
      return {
        type: "goto-exhausted",
        ...envelope(o),
        target_node_id: o.targetNodeId,
        target_node_name: o.targetNodeName,
        max_jumps: o.maxJumps,
        pass: o.pass,
      };
    case "join-applied":
      // A controller has no run of its own (invariant 1): run_id is the enclosing run, node_id the node.
      return {
        type: "join-applied",
        ...envelope(o),
        branches: o.branches,
        published_keys: o.publishedKeys,
        // Present only on a `wait-one` win (wait-one-join.md §8); JSON.stringify drops it when absent.
        winner: o.winner,
      };
    case "run-cancelled":
      // Paired with a `cancelled` step-finished; `cause` distinguishes a sibling from an operator stop.
      return { type: "run-cancelled", ...envelope(o), cause: o.cause, cause_run_id: o.causeRunId };
    case "step-awaiting":
      // Rides the log so an `awaiting`/Complete cycle reconstructs who the activity was for.
      return { type: "step-awaiting", ...envelope(o), assignee: o.assignee };
    case "reuse-marker":
      // A reused node's whole narrative, where no step-lifecycle pair carries it: node_id is the
      // reused node's own id and original_run_id back-references the tree holding the real data.
      return { type: "reuse-marker", ...envelope(o), original_run_id: o.originalRunId };
    // Persistence-only: no log event exists for these.
    case "step-stderr":
    case "step-usage":
    case "context-changed":
    case "step-context":
      return null;
    default: {
      const exhaustive: never = o;
      return exhaustive;
    }
  }
}

/**
 * A `RunObserver` that turns run/step lifecycle hooks into the typed log-event stream (mvp spec §8.1)
 * and fans it out to every backend; envelope assembly, `seq` and masking happen here, engine-side.
 *
 * Failure policy (§8.2): any *active* backend write failure rejects the hook so `runWorkflow` fails the
 * run, and the failed backend is dropped; terminal events are still emitted best-effort to survivors.
 */
export interface LoggingObserverOptions {
  startSeq?: number;
  append?: boolean;
}

export function createLoggingObserver(
  backends: LogBackend[],
  options: LoggingObserverOptions = {},
): RunObserver {
  const managed: ManagedBackend[] = backends.map((backend) => ({
    backend,
    active: true,
    tail: Promise.resolve(),
  }));
  // `startSeq` keeps a Complete's appended events monotonic instead of colliding at 1.
  let seq = options.startSeq ?? 0;
  const append = options.append ?? false;
  let opened = false;
  let terminated = false;

  // Every observation carries the node identity it is about (ADR 0007), so this observer keeps no
  // per-run state and its output cannot depend on the order of the stream it was handed.
  function envelope(o: Observation): Envelope {
    seq += 1;
    return {
      seq,
      ts: new Date().toISOString(),
      run_id: o.runId,
      node_id: o.nodeId,
      node_name: o.nodeName,
    };
  }

  // Runs only after that backend's previous op settles, so it never sees concurrent calls. A rejection
  // doesn't poison the chain, but the returned promise still rejects so the caller can react.
  function enqueue(mb: ManagedBackend, op: () => Promise<void>): Promise<void> {
    const done = mb.tail.then(op);
    mb.tail = done.catch(() => {});
    return done;
  }

  // Runs `op` on every still-active backend concurrently, dropping any that reject. `label` fails the
  // run via ObserverError unless `best-effort` — terminal events drop failures without rejecting.
  async function fanOut(
    op: (mb: ManagedBackend) => Promise<void>,
    { label, bestEffort }: { label: string; bestEffort: boolean },
  ): Promise<void> {
    const targets = managed.filter((mb) => mb.active);
    const results = await Promise.allSettled(targets.map((mb) => enqueue(mb, () => op(mb))));
    const reasons: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        targets[i]!.active = false;
        reasons.push(
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    });
    if (!bestEffort && reasons.length > 0)
      throw new ObserverError(`${label}: ${reasons.join("; ")}`);
  }

  async function openAll(runId: string): Promise<void> {
    await fanOut((mb) => mb.backend.open({ runId, format: LOG_FORMAT, append }), {
      label: "log backend open failed",
      bestEffort: false,
    });
  }

  // Delivers one schema-valid event to every active backend. `terminal` events are best-effort (§8.2).
  async function emit(event: LogEvent, terminal: boolean): Promise<void> {
    const parsed = LogEventSchema.parse(event); // uphold "every event validates against the schema"
    await fanOut((mb) => mb.backend.write(parsed), {
      label: "log backend write failed",
      bestEffort: terminal,
    });
  }

  return {
    async observe(o) {
      // Opening on the first observation also covers a **Complete re-invocation** (ADR 0041), whose
      // re-entered root emits no fresh `run-started` but still carries the root run id to open under.
      if (!opened) {
        opened = true;
        await openAll(o.rootRunId);
      }
      // The root run's own finish is terminal: best-effort, idempotent, then every backend closes.
      const terminal = o.type === "run-finished" && o.runId === o.rootRunId;
      if (terminal) {
        if (terminated) return;
        terminated = true;
      }

      const event = toLogEvent(o, envelope);
      if (event !== null) await emit(event, terminal);

      if (terminal)
        await Promise.allSettled(managed.map((mb) => enqueue(mb, () => mb.backend.close())));
    },
  };
}
